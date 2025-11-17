const axios = require('axios');
const Order = require('../models/Order');

const STATUS_MAP = {
  new: 'processing',
  pending: 'processing',
  confirmed: 'confirmed',
  'pickup scheduled': 'pickup_scheduled',
  'pickup scheduled today': 'pickup_scheduled',
  'pickup generated': 'pickup_scheduled',
  manifest: 'pickup_scheduled',
  shipped: 'shipped',
  transit: 'in_transit',
  'in transit': 'in_transit',
  'out for delivery': 'out_for_delivery',
  'customer not available': 'out_for_delivery',
  delivered: 'delivered',
  cancelled: 'cancelled',
  'rto initiated': 'rto_initiated',
  'rto delivered': 'rto_delivered',
  'return initiated': 'return_initiated',
  'return pending': 'return_initiated',
  'return picked up': 'return_in_transit',
  'return in transit': 'return_in_transit',
  'return delivered': 'returned'
};

class ShiprocketService {
  constructor() {
    this.baseURL =
      process.env.SHIPROCKET_API_URL || 'https://apiv2.shiprocket.in/v1/external';
    this.email = process.env.SHIPROCKET_EMAIL;
    this.password = process.env.SHIPROCKET_PASSWORD;
    this.pickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION;
    this.pickupPincode = process.env.SHIPROCKET_PICKUP_PINCODE;
    this.pickupAddress = process.env.SHIPROCKET_PICKUP_ADDRESS || '';
    this.pickupCity = process.env.SHIPROCKET_PICKUP_CITY || '';
    this.pickupState = process.env.SHIPROCKET_PICKUP_STATE || '';
    this.pickupPhone = process.env.SHIPROCKET_PICKUP_PHONE || '';
    this.companyName = process.env.SHIPROCKET_COMPANY_NAME || 'Maytastic';
    this.channelId = process.env.SHIPROCKET_CHANNEL_ID;
    this.defaultMode = process.env.SHIPROCKET_DEFAULT_MODE || 'Surface';
    this.defaultHsn = process.env.SHIPROCKET_DEFAULT_HSN || '61091000';
    this.defaults = {
      weight: Number(process.env.SHIPROCKET_FALLBACK_ITEM_WEIGHT_KG) || 0.5,
      length: Number(process.env.SHIPROCKET_FALLBACK_LENGTH_CM) || 20,
      breadth: Number(process.env.SHIPROCKET_FALLBACK_BREADTH_CM) || 16,
      height: Number(process.env.SHIPROCKET_FALLBACK_HEIGHT_CM) || 4
    };
    this.token = null;
    this.tokenExpiresAt = 0;
    this.providerName = 'shiprocket';
  }

  isEnabled() {
    return Boolean(this.email && this.password && this.pickupLocation);
  }

  normalizeStatus(status = '') {
    const normalized = status.toString().trim().toLowerCase();
    return STATUS_MAP[normalized] || null;
  }

  async authenticate(force = false) {
    if (!this.isEnabled()) {
      throw new Error('Shiprocket credentials are not configured');
    }

    const now = Date.now();
    if (!force && this.token && this.tokenExpiresAt > now + 60 * 1000) {
      return this.token;
    }

    const response = await axios.post(`${this.baseURL}/auth/login`, {
      email: this.email,
      password: this.password
    });

    this.token = response.data?.token;
    const expiresIn = Number(response.data?.expires_in || 0) * 1000;
    this.tokenExpiresAt = now + (expiresIn || 10 * 60 * 1000);
    return this.token;
  }

  async request(config) {
    try {
      const token = await this.authenticate();
      const headers = {
        Authorization: `Bearer ${token}`,
        ...(config.headers || {})
      };

      const response = await axios({
        baseURL: this.baseURL,
        timeout: 15000,
        ...config,
        headers
      });

      return response;
    } catch (error) {
      if (error?.response?.status === 401) {
        // Retry once with a fresh token
        if (!config._retry) {
          return this.request({ ...config, _retry: true });
        }
      }
      throw error;
    }
  }

  async getRateQuote({
    destinationPincode,
    cod = false,
    orderAmount = 0,
    weight,
    dimensions = {}
  }) {
    if (!this.isEnabled()) {
      return null;
    }

    if (!destinationPincode) {
      throw new Error('Destination pincode is required for rate quote');
    }

    const safeWeight = Math.max(weight || this.defaults.weight, 0.1);
    const params = {
      pickup_postcode: this.pickupPincode,
      delivery_postcode: destinationPincode,
      cod: cod ? 1 : 0,
      weight: safeWeight,
      order_type: cod ? 'COD' : 'prepaid',
      mode: this.defaultMode,
      order_amount: orderAmount || safeWeight * 100
    };

    if (dimensions.length) params.length = dimensions.length;
    if (dimensions.breadth) params.breadth = dimensions.breadth;
    if (dimensions.height) params.height = dimensions.height;

    const response = await this.request({
      method: 'get',
      url: '/courier/serviceability/',
      params
    });

    const companies =
      response.data?.data?.available_courier_companies || [];

    if (!companies.length) {
      return null;
    }

    const sorted = companies
      .filter((company) => company?.courier_company_id)
      .sort((a, b) => {
        const aDays = Number(a.estimated_delivery_days || a.etd || 99);
        const bDays = Number(b.estimated_delivery_days || b.etd || 99);
        if (aDays !== bDays) return aDays - bDays;
        return (a.rate || a.freight_charge || 0) -
          (b.rate || b.freight_charge || 0);
      });

    const chosen = sorted[0] || companies[0];
    const freight = Number(chosen.freight_charge || chosen.rate || 0);
    const codCharge = Number(chosen.cod_charges || 0);
    const fuel = Number(chosen.fuel_surcharge || 0);
    const charge = freight + codCharge + fuel;

    const etaDays = Number(
      chosen.estimated_delivery_days ||
        chosen.etd ||
        chosen.etd_days ||
        null
    );
    const etd = Number.isFinite(etaDays)
      ? new Date(Date.now() + etaDays * 24 * 60 * 60 * 1000)
      : null;

    return {
      courierCompanyId: chosen.courier_company_id,
      courierName: chosen.courier_name,
      charge,
      codCharge,
      freightCharge: freight,
      fuelSurcharge: fuel,
      totalCharge: Number(chosen.total_amount || charge),
      etd,
      raw: chosen
    };
  }

  buildShipmentPayload(order, { logistics, quote, isReturn = false, reason }) {
    const shipping = order.shippingAddress || {};
    const user = order.user || {};
    const items = (order.items || []).map((item) => ({
      name: item.name,
      sku: (item.product && item.product.toString && item.product.toString()) || item.name,
      units: item.quantity,
      selling_price: item.price,
      hsn: this.defaultHsn
    }));

    const basePayload = {
      order_id: isReturn
        ? `${order.orderNumber}-RET-${Date.now()}`
        : order.orderNumber,
      order_date: new Date().toISOString(),
      channel_id: this.channelId,
      pickup_location: this.pickupLocation,
      billing_customer_name: shipping.name || user.name || 'Customer',
      billing_last_name: '',
      billing_address: shipping.addressLine1 || '',
      billing_address_2: shipping.addressLine2 || '',
      billing_city: shipping.city || '',
      billing_pincode: shipping.pincode || '',
      billing_state: shipping.state || '',
      billing_country: 'India',
      billing_email: user.email || process.env.SHIPROCKET_FALLBACK_EMAIL,
      billing_phone: shipping.phone || this.pickupPhone,
      shipping_is_billing: true,
      order_items: items,
      payment_method: order.paymentMethod === 'cod' ? 'COD' : 'Prepaid',
      sub_total: Number(order.subtotal || 0),
      length: logistics.length || this.defaults.length,
      breadth: logistics.breadth || this.defaults.breadth,
      height: logistics.height || this.defaults.height,
      weight: Math.max(logistics.weight || this.defaults.weight, 0.1),
      order_amount: Number(order.total || order.subtotal || 0),
      courier_id: quote?.courierCompanyId,
      comment: reason || undefined,
      cod_charges: quote?.codCharge,
      shipping_charges: quote?.freightCharge
    };

    if (isReturn) {
      basePayload.is_return = 1;
      basePayload.reverse_pickup = 1;
      basePayload.pickup_customer_name = shipping.name || user.name || 'Customer';
      basePayload.pickup_last_name = '';
      basePayload.pickup_address = shipping.addressLine1 || '';
      basePayload.pickup_address_2 = shipping.addressLine2 || '';
      basePayload.pickup_city = shipping.city || '';
      basePayload.pickup_state = shipping.state || '';
      basePayload.pickup_pincode = shipping.pincode || '';
      basePayload.pickup_country = 'India';
      basePayload.pickup_phone = shipping.phone || user.phone || this.pickupPhone;
      basePayload.return_reason = reason || 'Customer return';
      basePayload.payment_method = 'Prepaid';
    }

    Object.keys(basePayload).forEach((key) => {
      if (
        basePayload[key] === undefined ||
        basePayload[key] === null ||
        basePayload[key] === ''
      ) {
        delete basePayload[key];
      }
    });

    return basePayload;
  }

  async createShipment(order, { logistics, quote } = {}) {
    if (!this.isEnabled()) {
      return order;
    }

    const payload = this.buildShipmentPayload(order, {
      logistics: logistics || this.defaults,
      quote
    });

    const response = await this.request({
      method: 'post',
      url: '/orders/create/adhoc',
      data: payload
    });

    const data = response.data?.data || response.data;
    if (!data) {
      return order;
    }

    const mappedStatus = this.normalizeStatus(data.status) || order.orderStatus;

    order.shippingIntegration = {
      ...(order.shippingIntegration || {}),
      provider: this.providerName,
      orderId: data.order_id || data.order_code || order.shippingIntegration?.orderId,
      shipmentId: data.shipment_id || order.shippingIntegration?.shipmentId,
      courierCompanyId:
        quote?.courierCompanyId ||
        data.courier_company_id ||
        order.shippingIntegration?.courierCompanyId,
      courierName:
        quote?.courierName ||
        data.courier_name ||
        order.shippingIntegration?.courierName,
      awb: data.awb_code || data.awb || order.shippingIntegration?.awb,
      trackingUrl:
        data.tracking_url ||
        order.shippingIntegration?.trackingUrl ||
        (data.awb_code
          ? `https://shiprocket.co/tracking/${data.awb_code}`
          : undefined),
      labelUrl: data.label_url || order.shippingIntegration?.labelUrl,
      invoiceUrl: data.invoice_url || order.shippingIntegration?.invoiceUrl,
      manifestUrl: data.manifest_url || order.shippingIntegration?.manifestUrl,
      pickupScheduledAt:
        data.pickup_scheduled_date || order.shippingIntegration?.pickupScheduledAt,
      status: data.status || order.shippingIntegration?.status,
      etd: quote?.etd || order.shippingIntegration?.etd,
      charge: quote?.charge || order.shippingIntegration?.charge,
      totalCharge:
        quote?.totalCharge || order.shippingIntegration?.totalCharge,
      codCharge: quote?.codCharge || order.shippingIntegration?.codCharge,
      weight: logistics?.weight || order.shippingIntegration?.weight,
      dimensions: logistics
        ? {
            length: logistics.length,
            breadth: logistics.breadth,
            height: logistics.height
          }
        : order.shippingIntegration?.dimensions,
      rateQuoteId:
        quote?.courierCompanyId || order.shippingIntegration?.rateQuoteId,
      rateResponse: quote?.raw || order.shippingIntegration?.rateResponse,
      lastSyncedAt: new Date()
    };

    if (mappedStatus) {
      order.orderStatus = mappedStatus;
    }

    order.updatedAt = Date.now();
    await order.save();
    return order;
  }

  async cancelShipment(order) {
    if (!this.isEnabled()) return null;
    const shipOrderId =
      order.shippingIntegration?.orderId ||
      order.shippingIntegration?.shipmentId;
    if (!shipOrderId) return null;

    await this.request({
      method: 'post',
      url: '/orders/cancel',
      data: {
        ids: [shipOrderId]
      }
    });

    order.shippingIntegration = {
      ...(order.shippingIntegration || {}),
      status: 'cancelled',
      lastSyncedAt: new Date()
    };
    order.orderStatus = 'cancelled';
    await order.save();
    return order;
  }

  async createReturnShipment(order, { logistics, quote, reason } = {}) {
    if (!this.isEnabled()) {
      throw new Error('Return shipments require Shiprocket configuration');
    }

    const payload = this.buildShipmentPayload(order, {
      logistics: logistics || this.defaults,
      quote,
      isReturn: true,
      reason
    });

    const response = await this.request({
      method: 'post',
      url: '/orders/create/adhoc',
      data: payload
    });

    const data = response.data?.data || response.data;

    order.returnStatus = 'return_initiated';
    order.shippingIntegration = {
      ...(order.shippingIntegration || {}),
      returnShipmentId: data.shipment_id,
      returnAwb: data.awb_code || data.awb,
      returnTrackingUrl:
        data.tracking_url ||
        (data.awb_code
          ? `https://shiprocket.co/tracking/${data.awb_code}`
          : undefined),
      lastSyncedAt: new Date()
    };
    order.updatedAt = Date.now();
    await order.save();
    return order;
  }

  async fetchTracking(order) {
    if (!this.isEnabled()) return order.shippingIntegration;
    const awb = order.shippingIntegration?.awb;
    if (!awb) return order.shippingIntegration;

    const response = await this.request({
      method: 'get',
      url: `/courier/track/awb/${awb}`
    });

    const trackingData = response.data?.tracking_data;

    if (!trackingData) {
      return order.shippingIntegration;
    }

    const events = (trackingData.shipment_track || []).map((event) => ({
      status: event.current_status || event.status,
      message: event.remarks || event.remark,
      location: event.current_city || event.location,
      eventAt: event.date
        ? new Date(event.date)
        : event.event_date
        ? new Date(event.event_date)
        : new Date()
    }));

    const latestStatus = trackingData.current_status || trackingData.status;
    const mappedStatus =
      this.normalizeStatus(latestStatus) || order.orderStatus;

    order.shippingIntegration = {
      ...(order.shippingIntegration || {}),
      status: latestStatus || order.shippingIntegration?.status,
      trackingUrl:
        trackingData.track_url ||
        trackingData.url ||
        order.shippingIntegration?.trackingUrl,
      etd: trackingData.edd
        ? new Date(trackingData.edd)
        : order.shippingIntegration?.etd,
      deliveredAt:
        mappedStatus === 'delivered'
          ? new Date()
          : order.shippingIntegration?.deliveredAt,
      trackingHistory: events.length
        ? events
        : order.shippingIntegration?.trackingHistory,
      lastSyncedAt: new Date()
    };

    if (mappedStatus) {
      order.orderStatus = mappedStatus;
    }

    order.updatedAt = Date.now();
    await order.save();

    return order.shippingIntegration;
  }

  async syncTracking(orderId) {
    const order =
      typeof orderId === 'string'
        ? await Order.findById(orderId)
        : orderId;
    if (!order) {
      throw new Error('Order not found');
    }
    await order.populate('user', 'name email phone');
    await this.fetchTracking(order);
    return order;
  }
}

module.exports = new ShiprocketService();

