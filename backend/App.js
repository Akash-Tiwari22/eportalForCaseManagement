// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({origin: 'http://localhost:3000',
    credentials: true}));
app.use(express.json());
// MongoDB connection
const mongoDBURI = process.env.MONGODB_URI ||  'mongodb://localhost:27017/legal_portal';
mongoose.connect(mongoDBURI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.error('MongoDB connection error:', err));
// User Schema

// In your server.js, modify the user schema:

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    dob: { type: Date, required: true },
    gender: { type: String, required: true },
    state: { type: String, required: true },
    district: { type: String, required: true },
    placeOfPractice: { type: String, required: function() {
        return this.userType === 'advocate' || this.userType === 'clerk';
    }},
    email: { type: String, required: true, unique: true },
    mobile: { type: String, required: true },
    password: { type: String, required: true },
    userType: { type: String, required: true, enum: ['advocate', 'litigant', 'clerk'] },
    barDetails: {
        state: String,
        number: String,
        year: String
    },
    createdAt: { type: Date, default: Date.now },
    lastLogin: Date
});
// User Model
const User = mongoose.model('User', userSchema);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ message: 'No token provided' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Attach decoded payload to req.user
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Invalid token' });
    }
};


// In your server.js, modify the registration endpoint:

app.post('/api/register', async (req, res) => {
    try {
        // Check if user already exists
        const emailExists = await User.findOne({ email: req.body.email });
        if (emailExists) {
            return res.status(400).json({ message: 'Email already exists' });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(req.body.password, salt);

        // Create new user object
        const userData = {
            name: req.body.name,
            dob: new Date(req.body.dob),
            gender: req.body.gender,
            state: req.body.state,
            district: req.body.district,
            email: req.body.email,
            mobile: req.body.mobile,
            password: hashedPassword,
            userType: req.body.userType
        };

        // Add placeOfPractice only for advocate and clerk
        if (req.body.userType !== 'litigant') {
            userData.placeOfPractice = req.body.placeOfPractice;
        }

        // Add bar details if user is advocate
        if (req.body.userType === 'advocate') {
            userData.barDetails = {
                state: req.body.barState,
                number: req.body.barNumber,
                year: req.body.barYear
            };
        }

        // Save user to database
        const user = new User(userData);
        const savedUser = await user.save();

        // Create and assign token
        const token = jwt.sign(
            {
                userId: user._id, // Explicitly include userId
                email: user.email,
                userType: user.userType,
            },
            JWT_SECRET,
            { expiresIn: '2M' }
        );
        

        res.status(201).json({
            message: 'User registered successfully',
            token,
            user: {
                id: savedUser._id,
                name: savedUser.name,
                email: savedUser.email,
                userType: savedUser.userType
            }
        });
    } catch (error) {
        console.error('Registration error:', error); // Add this for debugging
        res.status(500).json({ message: error.message });
    }
});

// Get User Profile API
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId)
            .select('name email userType'); // Explicitly include fields you want to return
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            success: true,
            user: {
                name: user.name,
                email: user.email,
                userType: user.userType,
            },
        });
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ message: 'Error fetching profile', error: error.message });
    }
});


// Update User Profile API
app.put('/api/profile', authenticateToken, async (req, res) => {
    try {
        const updates = { ...req.body };
        delete updates.password; // Prevent password update through this endpoint

        const user = await User.findByIdAndUpdate(
            req.user._id,
            { $set: updates },
            { new: true }
        ).select('-password');

        res.json({
            message: 'Profile updated successfully',
            user
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Change Password API
app.post('/api/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
        const user = await User.findById(req.user._id);
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        
        if (!validPassword) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
// Login Route
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        // Check password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        // Update last login
        user.lastLogin = new Date();
        await user.save();

        // Generate token
        const token = jwt.sign(
            {
                userId: user._id,
                email: user.email,
                userType: user.userType,
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            userType: user.userType,
            message: 'Login successful',
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});
// Protected Route Example
app.get('/api/protected', authenticateToken, (req, res) => {
    res.json({ message: 'Protected data', user: req.user });
  });
  
  
// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});