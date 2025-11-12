const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { auth, adminAuth } = require('../middleware/auth');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const router = express.Router();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'your_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'your_key_secret'
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
            order,
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
        order,
        message: 'Order created successfully'
      };
    });

    if (result.razorpayOrderId) {
      return res.status(201).json(result);
    }

    res.status(201).json(result);
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

// @route   PUT /api/orders/:id/status
// @desc    Update order status (Admin only)
// @access  Private/Admin
router.put('/:id/status', auth, adminAuth, async (req, res) => {
  try {
    const { orderStatus } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus, updatedAt: Date.now() },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   PUT /api/orders/:id/cancel
// @desc    Allow user to cancel their own order (if eligible)
// @access  Private
router.put('/:id/cancel', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Only the owner can cancel their order
    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Only allow cancellation if order is not already shipped/delivered/cancelled
    if (['shipped', 'delivered', 'cancelled'].includes(order.orderStatus)) {
      return res.status(400).json({ message: `Order cannot be cancelled (status: ${order.orderStatus})` });
    }

    // Mark as cancelled by user
    order.orderStatus = 'cancelled';
    order.cancelledByUser = true;
    order.cancelledAt = Date.now();
    if (req.body.cancelReason) order.cancelReason = req.body.cancelReason;
    order.updatedAt = Date.now();

    // If payment was already completed for an online payment, mark as refunded
    // NOTE: real refunds should be processed through the payment gateway; this is a simple flag update
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

