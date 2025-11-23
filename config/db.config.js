const mongoose = require('mongoose');

// Database Connection
const connectoDB = async () => {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kancharanatanay2006_db_user:q5zl8xLAz0PMaCm2@maytastic.nam4hiu.mongodb.net/?appName=Maytastic';
    mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    })
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));
};

module.exports = connectoDB;