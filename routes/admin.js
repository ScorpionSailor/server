const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { auth, adminAuth } = require('../middleware/auth');

const router = express.Router();

// All routes require admin authentication
router.use(auth, adminAuth);

// @route   GET /api/admin/stats
// @desc    Get admin dashboard statistics
// @access  Private/Admin
router.get('/stats', async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const totalOrders = await Order.countDocuments();
    const totalUsers = await User.countDocuments({ role: 'user' });
    
    // Get COD revenue (delivered orders only)
    const codRevenue = await Order.aggregate([
      { 
        $match: { 
          paymentMethod: 'cod',
          orderStatus: 'delivered'
        } 
      },
      { 
        $group: { 
          _id: null, 
          total: { $sum: '$total' } 
        } 
      }
    ]);

    // Get online payments revenue (completed payments)
    const onlineRevenue = await Order.aggregate([
      { 
        $match: { 
          paymentMethod: { $in: ['upi', 'card', 'netbanking', 'razorpay'] },
          paymentStatus: 'completed'
        } 
      },
      { 
        $group: { 
          _id: null, 
          total: { $sum: '$total' } 
        } 
      }
    ]);

    const recentOrders = await Order.find()
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(10);

    // Count and sample orders cancelled by users
    const canceledOrdersCount = await Order.countDocuments({ cancelledByUser: true });
    const recentCanceledOrders = await Order.find({ cancelledByUser: true })
      .populate('user', 'name email')
      .sort({ cancelledAt: -1 })
      .limit(10);

    res.json({
      totalProducts,
      totalOrders,
      totalUsers,
      codRevenue: codRevenue[0]?.total || 0,
      onlineRevenue: onlineRevenue[0]?.total || 0,
      totalRevenue: (codRevenue[0]?.total || 0) + (onlineRevenue[0]?.total || 0),
      canceledOrdersCount,
      recentCanceledOrders,
      recentOrders
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/admin/products
// @desc    Get all products for admin
// @access  Private/Admin
router.get('/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   POST /api/admin/products
// @desc    Create a new product (Admin only)
// @access  Private/Admin
router.post('/products', async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      category,
      type,
      images = [],
      sizes = [],
      colors = [],
      comparePrice,
      inStock,
      stock,
      featured,
      trending,
      newArrival,
      tags
    } = req.body;

    if (!name || !description || price === undefined || !category || !type) {
      return res.status(400).json({ message: 'name, description, price, category, and type are required' });
    }

    const product = new Product({
      name,
      description,
      price,
      category,
      type,
      images,
      sizes,
      colors,
      comparePrice,
      inStock,
      stock,
      featured,
      trending,
      newArrival,
      tags
    });

    await product.save();
    res.status(201).json(product);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/admin/orders
// @desc    Get all orders for admin
// @access  Private/Admin
router.get('/orders', async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('user', 'name email')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/admin/users
// @desc    Get all users for admin
// @access  Private/Admin
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({ role: 'user' })
      .select('-password')
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

// @route   GET /api/admin/canceled-orders
// @desc    Get orders cancelled by users (Admin only)
// @access  Private/Admin
router.get('/canceled-orders', async (req, res) => {
  try {
    const orders = await Order.find({ cancelledByUser: true })
      .populate('user', 'name email')
      .populate('items.product', 'name images')
      .sort({ cancelledAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

