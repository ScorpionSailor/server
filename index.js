const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const path = require('path');
const connectoDB = require('./config/db.config');

// Connect to Database
connectoDB();
dotenv.config();

const app = express();

// Middleware
// Allowlist of origins can be configured via ALLOWED_ORIGINS env var (comma-separated)
const allowed = (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.split(',')) || [
  'https://maytastic.com',
  'https://www.maytastic.com'
];

app.use(cors({
  origin: (origin, cb) => {
    // If no origin (e.g., server-to-server, curl, mobile apps), allow
    if (!origin) return cb(null, true);

    // If origin is allowed, allow it
    if (allowed.includes(origin)) return cb(null, true);

    // Not allowed: do NOT throw an error (that surfaces server-side); instead deny CORS
    // Log for debugging and return callback with false so the CORS middleware will not set CORS headers
    console.warn('Blocked CORS origin:', origin);
    return cb(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 200
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'API is running' });
});

// Redirect any non-API requests to the client site in production to avoid 404 noise
if (process.env.NODE_ENV === 'production') {
  const clientUrl = process.env.CLIENT_URL || 'https://maytastic.com';
  app.use((req, res, next) => {
    // If the request path starts with /api, let API routes handle it
    if (req.path.startsWith('/api')) return next();

    // Otherwise redirect to client (preserve path and query)
    const target = `${clientUrl}${req.originalUrl}`;
    console.info('Redirecting non-API request to client:', req.originalUrl, '->', target);
    return res.redirect(302, target);
  });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;

