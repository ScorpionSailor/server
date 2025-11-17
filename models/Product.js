const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true
    },
    alt: {
      type: String,
      default: ''
    },
    // Optional color reference so a single gallery can drive color-specific slides
    color: {
      type: String,
      trim: true,
      default: null
    }
  },
  { _id: false }
);

const variantImageSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true
    },
    alt: {
      type: String,
      default: ''
    }
  },
  { _id: false }
);

const sizeSchema = new mongoose.Schema(
  {
    size: {
      type: String,
      required: true,
      trim: true
    },
    stock: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { _id: false }
);

const colorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    hex: {
      type: String,
      trim: true
    },
    images: {
      type: [variantImageSchema],
      default: []
    }
  },
  { _id: false }
);

const shippingProfileSchema = new mongoose.Schema(
  {
    weight: {
      type: Number,
      default: 0.5,
      min: 0
    },
    length: {
      type: Number,
      default: 20,
      min: 0
    },
    breadth: {
      type: Number,
      default: 16,
      min: 0
    },
    height: {
      type: Number,
      default: 4,
      min: 0
    },
    hsCode: {
      type: String,
      trim: true
    }
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      required: true
    },
    price: {
      type: Number,
      required: true,
      min: 0
    },
    comparePrice: {
      type: Number,
      default: null,
      min: 0
    },
    category: {
      type: String,
      required: true,
      trim: true
    },
    type: {
      type: String,
      required: true,
      trim: true
    },
    images: {
      type: [imageSchema],
      default: []
    },
    sizes: {
      type: [sizeSchema],
      default: []
    },
    colors: {
      type: [colorSchema],
      default: []
    },
    inStock: {
      type: Boolean,
      default: true
    },
    stock: {
      type: Number,
      default: 0,
      min: 0
    },
    featured: {
      type: Boolean,
      default: false
    },
    trending: {
      type: Boolean,
      default: false
    },
    newArrival: {
      type: Boolean,
      default: false
    },
    tags: {
      type: [String],
      default: []
    },
    shippingProfile: {
      type: shippingProfileSchema,
      default: () => ({
        weight: 0.5,
        length: 20,
        breadth: 16,
        height: 4
      })
    }
  },
  {
    timestamps: true
  }
);

productSchema.methods.hasAvailableStock = function () {
  const baseStock = typeof this.stock === 'number' ? this.stock : 0;
  const sizeStock = Array.isArray(this.sizes)
    ? this.sizes.some((entry) => typeof entry.stock === 'number' && entry.stock > 0)
    : false;

  return baseStock > 0 || sizeStock;
};

productSchema.pre('save', function (next) {
  this.inStock = this.hasAvailableStock();
  next();
});

productSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate() || {};
  if (update.$set || update.$inc || update.stock !== undefined) {
    // Ensure inStock stays in sync whenever stock-related fields change
    this.findOne().then((doc) => {
      if (!doc) return next();

      const pending = doc.toObject();
      if (typeof update.stock === 'number') {
        pending.stock = update.stock;
      }
      if (update.$set && typeof update.$set.stock === 'number') {
        pending.stock = update.$set.stock;
      }
      if (update.$inc && typeof update.$inc.stock === 'number') {
        pending.stock = (pending.stock || 0) + update.$inc.stock;
      }
      if (update.$set && Array.isArray(update.$set.sizes)) {
        pending.sizes = update.$set.sizes;
      }
      if (update.sizes) {
        pending.sizes = update.sizes;
      }

      update.$set = update.$set || {};
      update.$set.inStock =
        (typeof pending.stock === 'number' && pending.stock > 0) ||
        (Array.isArray(pending.sizes) &&
          pending.sizes.some((entry) => typeof entry.stock === 'number' && entry.stock > 0));
      this.setUpdate(update);
      next();
    }).catch(next);
  } else {
    next();
  }
});

module.exports = mongoose.model('Product', productSchema);
