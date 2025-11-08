const express = require('express');
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
  try {
    const { items, shippingAddress, paymentMethod } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Order must have items' });
    }

    if (!shippingAddress) {
      return res.status(400).json({ message: 'Shipping address is required' });
    }

    // Calculate totals
    let subtotal = 0;
    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(404).json({ message: `Product ${item.product} not found` });
      }
      subtotal += product.price * item.quantity;
    }

    const shipping = subtotal > 1000 ? 0 : 50;
    const tax = subtotal * 0.18; // 18% GST
    const total = subtotal + shipping + tax;

    // Create order
    const order = new Order({
      user: req.user.id,
      items,
      shippingAddress,
      paymentMethod,
      subtotal,
      shipping,
      tax,
      total
    });

    // Create Razorpay order if payment method is online
    if (paymentMethod === 'razorpay' || paymentMethod === 'upi' || paymentMethod === 'card' || paymentMethod === 'netbanking') {
      try {
        const razorpayOrder = await razorpay.orders.create({
          amount: total * 100, // Convert to paise
          currency: 'INR',
          receipt: `receipt_${Date.now()}`
        });

        order.razorpayOrderId = razorpayOrder.id;
        await order.save();

        return res.status(201).json({
          order,
          razorpayOrderId: razorpayOrder.id,
          keyId: process.env.RAZORPAY_KEY_ID
        });
      } catch (razorpayError) {
        console.error('Razorpay error:', razorpayError);
        return res.status(500).json({ message: 'Payment gateway error', error: razorpayError.message });
      }
    }

    await order.save();

    res.status(201).json({
      message: 'Order created successfully',
      order
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
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

