const mongoose = require('mongoose');

const trackingEventSchema = new mongoose.Schema(
  {
    status: String,
    location: String,
    message: String,
    eventAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const shippingIntegrationSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      default: 'shiprocket'
    },
    orderId: String,
    shipmentId: String,
    courierCompanyId: Number,
    courierName: String,
    awb: String,
    trackingUrl: String,
    labelUrl: String,
    invoiceUrl: String,
    manifestUrl: String,
    status: String,
    statusCode: String,
    pickupScheduledAt: Date,
    deliveredAt: Date,
    lastSyncedAt: Date,
    etd: Date,
    charge: Number,
    codCharge: Number,
    fuelSurcharge: Number,
    totalCharge: Number,
    weight: Number,
    dimensions: {
      length: Number,
      breadth: Number,
      height: Number
    },
    rateQuoteId: Number,
    rateResponse: mongoose.Schema.Types.Mixed,
    trackingHistory: [trackingEventSchema],
    returnShipmentId: String,
    returnAwb: String,
    returnTrackingUrl: String
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true,
    autoIncrement: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    name: String,
    size: String,
    color: String,
    quantity: Number,
    price: Number,
    image: String
  }],
  shippingAddress: {
    name: String,
    phone: String,
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    pincode: String
  },
  paymentMethod: {
    type: String,
    enum: ['upi', 'card', 'netbanking', 'cod', 'razorpay'],
    required: true
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending'
  },
  orderStatus: {
    type: String,
    enum: [
      'pending',
      'processing',
      'confirmed',
      'pickup_scheduled',
      'shipped',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'cancelled',
      'return_initiated',
      'return_in_transit',
      'returned',
      'rto_initiated',
      'rto_delivered'
    ],
    default: 'pending'
  },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  razorpaySignature: String,
  subtotal: {
    type: Number,
    required: true
  },
  shipping: {
    type: Number,
    default: 0
  },
  estimatedDeliveryAt: Date,
  tax: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
  ,
  // Track cancellations initiated by the user
  cancelledByUser: {
    type: Boolean,
    default: false
  },
  cancelledAt: Date,
  cancelReason: String,
  shippingIntegration: shippingIntegrationSchema,
  returnStatus: {
    type: String,
    enum: [
      'none',
      'return_initiated',
      'return_in_transit',
      'return_completed',
      'return_cancelled'
    ],
    default: 'none'
  },
  returnRequestedAt: Date,
  returnReason: String
});

// Generate unique order number before validation so required check passes
orderSchema.pre('validate', async function(next) {
  if (!this.orderNumber) {
    const count = await mongoose.model('Order').countDocuments();
    this.orderNumber = `MT${Date.now()}${count.toString().padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Order', orderSchema);

