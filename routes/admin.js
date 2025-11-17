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
      tags,
      shippingProfile
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
      tags,
      shippingProfile
    });

    await product.save();
    res.status(201).json(product);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   PATCH /api/admin/products/:id/stock
// @desc    Restock or update product quantities (Admin only)
// @access  Private/Admin
router.patch('/products/:id/stock', async (req, res) => {
  try {
    const { newStock, delta, sizeStockUpdates } = req.body || {};

    if (
      newStock === undefined &&
      delta === undefined &&
      !Array.isArray(sizeStockUpdates)
    ) {
      return res.status(400).json({
        message: 'Provide either newStock, delta, or sizeStockUpdates to adjust inventory'
      });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    if (typeof newStock === 'number') {
      if (newStock < 0) {
        return res.status(400).json({ message: 'newStock must be zero or greater' });
      }
      product.stock = newStock;
    } else if (typeof delta === 'number') {
      const adjusted = (product.stock || 0) + delta;
      if (adjusted < 0) {
        return res.status(400).json({ message: 'Resulting stock cannot be negative' });
      }
      product.stock = adjusted;
    }

    if (Array.isArray(sizeStockUpdates) && sizeStockUpdates.length) {
      const sizeMap = new Map(
        sizeStockUpdates
          .filter(
            (entry) =>
              entry &&
              typeof entry.size === 'string' &&
              typeof entry.stock === 'number' &&
              entry.stock >= 0
          )
          .map((entry) => [
            entry.size.toLowerCase(),
            { stock: entry.stock, name: entry.size }
          ])
      );

      if (sizeMap.size === 0) {
        return res.status(400).json({ message: 'sizeStockUpdates must include valid size and stock values' });
      }

      const existingSizes = new Map(
        (product.sizes || []).map((sizeEntry) => [
          sizeEntry.size ? sizeEntry.size.toLowerCase() : '',
          sizeEntry
        ])
      );

      const updatedSizes = [];

      existingSizes.forEach((value, key) => {
        if (sizeMap.has(key)) {
          const updateValue = sizeMap.get(key);
          updatedSizes.push({
            ...value,
            stock: updateValue.stock
          });
          sizeMap.delete(key);
        } else {
          updatedSizes.push(value);
        }
      });

      // Add new size entries that did not previously exist
      sizeMap.forEach((updateValue) => {
        updatedSizes.push({
          size: updateValue.name,
          stock: updateValue.stock
        });
      });

      product.sizes = updatedSizes;

      product.markModified('sizes');

      if (typeof newStock !== 'number' && typeof delta !== 'number') {
        product.stock = updatedSizes.reduce(
          (sum, entry) => sum + (typeof entry.stock === 'number' ? entry.stock : 0),
          0
        );
      }
    }

    product.inStock = product.hasAvailableStock();
    await product.save();

    res.json({
      message: 'Product stock updated successfully',
      product
    });
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

