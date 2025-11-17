const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { auth, adminAuth } = require('../middleware/auth');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const shiprocketService = require('../services/shiprocket');

const FALLBACK_WEIGHT =
  Number(process.env.SHIPROCKET_FALLBACK_ITEM_WEIGHT_KG) || 0.5;
const FALLBACK_LENGTH =
  Number(process.env.SHIPROCKET_FALLBACK_LENGTH_CM) || 20;
const FALLBACK_BREADTH =
  Number(process.env.SHIPROCKET_FALLBACK_BREADTH_CM) || 16;
const FALLBACK_HEIGHT =
  Number(process.env.SHIPROCKET_FALLBACK_HEIGHT_CM) || 4;

const getShippingMetrics = (product, quantity) => {
  const profile = product.shippingProfile || {};
  const weightPerUnit =
    typeof profile.weight === 'number' && profile.weight > 0
      ? profile.weight
      : FALLBACK_WEIGHT;
  const length = profile.length || FALLBACK_LENGTH;
  const breadth = profile.breadth || FALLBACK_BREADTH;
  const height = profile.height || FALLBACK_HEIGHT;

  return {
    weight: weightPerUnit * quantity,
    length,
    breadth,
    height
  };
};

const accumulateLogistics = (current, metrics) => {
  return {
    weight: Math.max(Number((current.weight || 0) + (metrics.weight || 0)), 0),
    length: Math.max(current.length || 0, metrics.length || FALLBACK_LENGTH),
    breadth: Math.max(
      current.breadth || 0,
      metrics.breadth || FALLBACK_BREADTH
    ),
    height: Math.max(current.height || 0, metrics.height || FALLBACK_HEIGHT)
  };
};

const router = express.Router();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'your_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'your_key_secret'
});

// @route   POST /api/orders/quote
// @desc    Get shipping quote from Shiprocket
// @access  Private
router.post('/quote', auth, async (req, res) => {
  try {
    const {
      destinationPincode,
      cod = false,
      orderAmount = 0,
      weight,
      dimensions = {}
    } = req.body || {};

    if (!destinationPincode) {
      return res
        .status(400)
        .json({ message: 'destinationPincode is required' });
    }

    const fallbackCharge = orderAmount > 1000 ? 0 : 50;

    if (!shiprocketService.isEnabled()) {
      return res.json({
        providerEnabled: false,
        charge: fallbackCharge,
        etd: null
      });
    }

    const quote = await shiprocketService.getRateQuote({
      destinationPincode,
      cod,
      orderAmount,
      weight,
      dimensions
    });

    if (!quote) {
      return res.json({
        providerEnabled: true,
        charge: fallbackCharge,
        etd: null
      });
    }

    res.json({
      providerEnabled: true,
      ...quote
    });
  } catch (error) {
    console.error('Shiprocket quote error:', error?.response?.data || error);
    res.status(502).json({
      message: 'Unable to fetch shipping quote at the moment',
      providerEnabled: shiprocketService.isEnabled()
    });
  }
});

// @route   POST /api/orders
// @desc    Create new order
// @access  Private
router.post('/', auth, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { items, shippingAddress, paymentMethod } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Order must have items' });
    }

    if (!shippingAddress) {
      return res.status(400).json({ message: 'Shipping address is required' });
    }

    const result = await session.withTransaction(async () => {
      let subtotal = 0;
      const orderItems = [];
      let logisticsSummary = {
        weight: 0,
        length: FALLBACK_LENGTH,
        breadth: FALLBACK_BREADTH,
        height: FALLBACK_HEIGHT
      };

      for (const item of items) {
        if (!item.product) {
          const error = new Error('Invalid order item');
          error.statusCode = 400;
          throw error;
        }

        const product = await Product.findById(item.product).session(session);
        if (!product) {
          const error = new Error(`Product ${item.product} not found`);
          error.statusCode = 404;
          throw error;
        }

        const quantity = Number(item.quantity) || 0;
        if (quantity <= 0) {
          const error = new Error('Quantity must be greater than zero');
          error.statusCode = 400;
          throw error;
        }

        const baseStock = typeof product.stock === 'number' ? product.stock : 0;
        const hasSizeVariants = Array.isArray(product.sizes) && product.sizes.length > 0;

        // Handle size level stock if available
        let selectedSizeEntry = null;
        if (item.size) {
          selectedSizeEntry = product.sizes?.find(
            (size) => size.size?.toLowerCase() === item.size.toLowerCase()
          );
          if (!selectedSizeEntry) {
            const error = new Error(`Size ${item.size} not available for ${product.name}`);
            error.statusCode = 400;
            throw error;
          }
          if ((selectedSizeEntry.stock || 0) < quantity) {
            const error = new Error(`Insufficient stock for ${product.name} - size ${item.size}`);
            error.statusCode = 409;
            throw error;
          }
          selectedSizeEntry.stock = Math.max(0, (selectedSizeEntry.stock || 0) - quantity);
          product.markModified('sizes');
        }

        if (!selectedSizeEntry && !hasSizeVariants && baseStock < quantity) {
          const error = new Error(`${product.name} is out of stock`);
          error.statusCode = 409;
          throw error;
        }

        if (!selectedSizeEntry && hasSizeVariants) {
          const variantTotal = product.sizes.reduce(
            (sum, sizeEntry) => sum + (typeof sizeEntry.stock === 'number' ? sizeEntry.stock : 0),
            0
          );

          if (variantTotal < quantity) {
            const error = new Error(`${product.name} is out of stock`);
            error.statusCode = 409;
            throw error;
          }
        }

        if (hasSizeVariants) {
          const recalculated = product.sizes.reduce(
            (sum, sizeEntry) => sum + (typeof sizeEntry.stock === 'number' ? sizeEntry.stock : 0),
            0
          );
          product.stock = Math.max(0, recalculated);
        } else {
          product.stock = Math.max(0, baseStock - quantity);
        }

        product.inStock = product.hasAvailableStock();

        // Persist stock changes
        await product.save({ session });

        const itemPrice = product.price;
        subtotal += itemPrice * quantity;

        // Default image selection: prioritize color-specific image if available
        let itemImage = product.images && product.images[0] ? product.images[0].url : null;
        if (item.color) {
          const targetColor = item.color.toLowerCase();
          const colorGallery =
            product.colors?.find((color) => color.name?.toLowerCase() === targetColor);
          if (colorGallery && Array.isArray(colorGallery.images) && colorGallery.images.length) {
            itemImage = colorGallery.images[0]?.url || itemImage;
          } else if (Array.isArray(product.images)) {
            const colorMatch = product.images.find(
              (img) => img.color && img.color.toLowerCase() === targetColor
            );
            if (colorMatch) {
              itemImage = colorMatch.url;
            }
          }
        }

        orderItems.push({
          product: product._id,
          name: product.name,
          size: item.size,
          color: item.color,
          quantity,
          price: itemPrice,
          image: itemImage
        });

        const metrics = getShippingMetrics(product, quantity);
        logisticsSummary = accumulateLogistics(logisticsSummary, metrics);
      }

      const shipping = subtotal > 1000 ? 0 : 50;
      const tax = subtotal * 0.18; // 18% GST
      const total = subtotal + shipping + tax;

      const order = new Order({
        user: req.user.id,
        items: orderItems,
        shippingAddress,
        paymentMethod,
        subtotal,
        shipping,
        tax,
        total
      });

      if (['razorpay', 'upi', 'card', 'netbanking'].includes(paymentMethod)) {
        try {
          const razorpayOrder = await razorpay.orders.create({
            amount: Math.round(total * 100), // paise
            currency: 'INR',
            receipt: `receipt_${Date.now()}`
          });

          order.razorpayOrderId = razorpayOrder.id;
          await order.save({ session });

          return {
            orderId: order._id,
            order,
            logistics: logisticsSummary,
            razorpayOrderId: razorpayOrder.id,
            keyId: process.env.RAZORPAY_KEY_ID
          };
        } catch (razorpayError) {
          console.error('Razorpay error:', razorpayError);
          const error = new Error(razorpayError.message || 'Payment gateway error');
          error.statusCode = 502;
          throw error;
        }
      }

      await order.save({ session });

      return {
        orderId: order._id,
        order,
        logistics: logisticsSummary,
        message: 'Order created successfully'
      };
    });

    let order = await Order.findById(result.orderId).populate(
      'user',
      'name email phone'
    );
    const logistics = result.logistics || {
      weight: FALLBACK_WEIGHT,
      length: FALLBACK_LENGTH,
      breadth: FALLBACK_BREADTH,
      height: FALLBACK_HEIGHT
    };

    const fallbackShipping = order.subtotal > 1000 ? 0 : 50;
    let shippingQuote = null;

    if (shiprocketService.isEnabled()) {
      try {
        shippingQuote = await shiprocketService.getRateQuote({
          destinationPincode: order.shippingAddress?.pincode,
          cod: order.paymentMethod === 'cod',
          orderAmount: order.subtotal + order.tax,
          weight: logistics.weight,
          dimensions: logistics
        });
      } catch (quoteError) {
        console.error(
          'Shiprocket quote post-order error:',
          quoteError?.response?.data || quoteError
        );
      }
    }

    const shippingCharge = shippingQuote?.charge ?? fallbackShipping;
    order.shipping = shippingCharge;
    order.total = order.subtotal + order.tax + shippingCharge;
    if (shippingQuote?.etd) {
      order.estimatedDeliveryAt = shippingQuote.etd;
    }

    if (shiprocketService.isEnabled()) {
      order.shippingIntegration = {
        ...(order.shippingIntegration || {}),
        provider: shiprocketService.providerName,
        weight: logistics.weight,
        dimensions: {
          length: logistics.length,
          breadth: logistics.breadth,
          height: logistics.height
        },
        charge: shippingQuote?.charge ?? order.shippingIntegration?.charge,
        codCharge:
          shippingQuote?.codCharge ?? order.shippingIntegration?.codCharge,
        totalCharge:
          shippingQuote?.totalCharge ?? order.shippingIntegration?.totalCharge,
        etd: shippingQuote?.etd ?? order.shippingIntegration?.etd,
        rateQuoteId:
          shippingQuote?.courierCompanyId ||
          order.shippingIntegration?.rateQuoteId,
        rateResponse:
          shippingQuote?.raw || order.shippingIntegration?.rateResponse,
        lastSyncedAt: new Date()
      };
    }

    await order.save();

    if (shiprocketService.isEnabled()) {
      try {
        order = await shiprocketService.createShipment(order, {
          logistics,
          quote: shippingQuote
        });
      } catch (shipmentError) {
        console.error(
          'Shiprocket shipment error:',
          shipmentError?.response?.data || shipmentError
        );
      }
    }

    const responsePayload = {
      ...result,
      order
    };
    delete responsePayload.logistics;

    res.status(201).json(responsePayload);
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    res.status(status).json({ message: error.message || 'Server error' });
  } finally {
    session.endSession();
  }
});

// @route   POST /api/orders/:id/verify
// @desc    Verify Razorpay payment
// @access  Private
router.post('/:id/verify', auth, async (req, res) => {
  try {
    const { razorpayPaymentId, razorpaySignature } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const text = order.razorpayOrderId + '|' + razorpayPaymentId;
    const hash = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(text)
      .digest('hex');

    if (hash === razorpaySignature) {
      order.paymentStatus = 'completed';
      order.paymentMethod = 'razorpay';
      order.razorpayPaymentId = razorpayPaymentId;
      order.razorpaySignature = razorpaySignature;
      await order.save();

      res.json({
        message: 'Payment verified successfully',
        order
      });
    } else {
      order.paymentStatus = 'failed';
      await order.save();
      
      res.status(400).json({ message: 'Payment verification failed' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/orders
// @desc    Get user's orders
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id })
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/orders/all
// @desc    Get all orders (Admin only)
// @access  Private/Admin
router.get('/all', auth, adminAuth, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('user', 'name email')
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/orders/:id/tracking
// @desc    Fetch latest tracking information for an order
// @access  Private
router.get('/:id/tracking', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate(
      'user',
      'name email phone role'
    );

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const isOwner = order.user?._id?.toString() === req.user.id;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (shiprocketService.isEnabled() && order.shippingIntegration?.awb) {
      try {
        await shiprocketService.fetchTracking(order);
      } catch (trackingError) {
        console.error(
          'Shiprocket tracking error:',
          trackingError?.response?.data || trackingError
        );
      }
    }

    res.json({
      orderStatus: order.orderStatus,
      estimatedDeliveryAt: order.estimatedDeliveryAt,
      shippingIntegration: order.shippingIntegration
    });
  } catch (error) {
    console.error('Tracking fetch error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   PUT /api/orders/:id/status
// @desc    Update order status (Admin only)
// @access  Private/Admin
router.put('/:id/status', auth, adminAuth, async (req, res) => {
  try {
    if (!shiprocketService.isEnabled()) {
      return res.status(400).json({
        message:
          'Shiprocket integration is disabled. Manual status updates are no longer supported.'
      });
    }

    const order = await shiprocketService.syncTracking(req.params.id);
    res.json({
      message: 'Order status refreshed from Shiprocket',
      order
    });
  } catch (error) {
    console.error('Status sync error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   POST /api/orders/:id/return
// @desc    Initiate a return shipment
// @access  Private
router.post('/:id/return', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate(
      'user',
      'name email phone role'
    );

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const isOwner = order.user?._id?.toString() === req.user.id;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (order.orderStatus !== 'delivered') {
      return res
        .status(400)
        .json({ message: 'Only delivered orders can be returned' });
    }

    if (order.returnStatus && order.returnStatus !== 'none') {
      return res
        .status(400)
        .json({ message: 'Return has already been initiated for this order' });
    }

    const reason = req.body?.reason?.trim() || 'Customer return';

    let updatedOrder = order;
    const logistics = {
      weight:
        order.shippingIntegration?.weight ||
        order.items.reduce(
          (sum, item) => sum + FALLBACK_WEIGHT * item.quantity,
          0
        ) ||
        FALLBACK_WEIGHT,
      length:
        order.shippingIntegration?.dimensions?.length || FALLBACK_LENGTH,
      breadth:
        order.shippingIntegration?.dimensions?.breadth || FALLBACK_BREADTH,
      height: order.shippingIntegration?.dimensions?.height || FALLBACK_HEIGHT
    };

    if (shiprocketService.isEnabled()) {
      try {
        updatedOrder = await shiprocketService.createReturnShipment(order, {
          logistics,
          reason
        });
      } catch (returnError) {
        console.error(
          'Shiprocket return error:',
          returnError?.response?.data || returnError
        );
        return res.status(502).json({
          message: 'Unable to schedule return shipment at the moment'
        });
      }
    } else {
      order.returnStatus = 'return_initiated';
      order.returnReason = reason;
      order.returnRequestedAt = new Date();
      await order.save();
      updatedOrder = order;
    }

    res.json({
      message: 'Return initiated successfully',
      order: updatedOrder
    });
  } catch (error) {
    console.error('Return initiation error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   POST /api/orders/:id/sync
// @desc    Force sync order status with Shiprocket (Admin)
// @access  Private/Admin
router.post('/:id/sync', auth, adminAuth, async (req, res) => {
  try {
    if (!shiprocketService.isEnabled()) {
      return res
        .status(400)
        .json({ message: 'Shiprocket integration is not configured' });
    }

    const order = await shiprocketService.syncTracking(req.params.id);
    res.json({
      message: 'Order synced with Shiprocket successfully',
      order
    });
  } catch (error) {
    console.error('Shiprocket sync error:', error);
    res.status(500).json({
      message: 'Failed to sync shipment with Shiprocket',
      error: error.message
    });
  }
});

// @route   PUT /api/orders/:id/cancel
// @desc    Allow user to cancel their own order (if eligible)
// @access  Private
router.put('/:id/cancel', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate(
      'user',
      'name email phone'
    );

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const isOwner = order.user && order.user._id
      ? order.user._id.toString() === req.user.id
      : order.user.toString() === req.user.id;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const nonCancelableStatuses = [
      'in_transit',
      'out_for_delivery',
      'delivered',
      'return_in_transit',
      'returned',
      'cancelled',
      'rto_delivered'
    ];

    if (!isAdmin && nonCancelableStatuses.includes(order.orderStatus)) {
      return res.status(400).json({
        message: `Order cannot be cancelled (status: ${order.orderStatus})`
      });
    }

    if (
      shiprocketService.isEnabled() &&
      order.shippingIntegration?.awb &&
      !['delivered', 'return_in_transit', 'returned'].includes(
        order.orderStatus
      )
    ) {
      try {
        await shiprocketService.cancelShipment(order);
      } catch (cancelError) {
        console.error(
          'Shiprocket cancel shipment error:',
          cancelError?.response?.data || cancelError
        );
      }
    }

    order.orderStatus = 'cancelled';
    order.cancelledByUser = !isAdmin;
    order.cancelledAt = Date.now();
    order.cancelReason =
      req.body.cancelReason ||
      order.cancelReason ||
      (isAdmin ? 'Cancelled by admin' : 'Cancelled by user');
    order.updatedAt = Date.now();
    if (order.shippingIntegration) {
      order.shippingIntegration.status = 'cancelled';
      order.shippingIntegration.lastSyncedAt = new Date();
    }

    if (order.paymentStatus === 'completed' && order.paymentMethod !== 'cod') {
      order.paymentStatus = 'refunded';
    }

    await order.save();

    res.json({ message: 'Order cancelled successfully', order });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

