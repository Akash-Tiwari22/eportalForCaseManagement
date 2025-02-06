
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const app = express();

// Middleware
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true
}));
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/daily_schedule')
    .then(() => console.log('MongoDB connected!'))
    .catch(err => console.error('MongoDB connection error:', err));

// Enrollment Record Schema (for verification)
const EnrollmentSchema = new mongoose.Schema({
    ENROLLMENT_NO: String,
    NAME_OF_ADVOCATE: String,
    FATHERS_NAME_OF_ADVOCATE: String,
    ADDRESS_OF_ADVOCATE: String,
    DISTRICT: String,
    DATE_OF_REGISTRATION: String,
    DATE_OF_BIRTH: String
});

const EnrollmentRecord = mongoose.model('EnrollmentRecord', EnrollmentSchema);

// Advocate Schema (for registered users)
const AdvocateSchema = new mongoose.Schema({
    advocate_id: { type: String, required: true, unique: true },
    enrollment_no: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    fathers_name: String,
    gender: { type: String, required: true },
    dob: { type: Date, required: true },
    contact: {
        email: String
    },
    address: String,
    district: { type: String, required: true },
    date_of_registration: Date,
    practice_details: {
        district_court: Boolean,
        high_court: Boolean,
        state: String,
        district: String,
        high_court_bench: String
    },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isEmailVerified: { type: Boolean, default: false },

    emailOTP: String,
    otpExpiry: Date,
    iCOP_number: { 
        type: String, 
        required: true,
        unique: true 
    },
    cop_document: {
        filename: String,
        path: String,
        uploadDate: Date
    },
    barId: { 
        type: String, 
        required: true,
        unique: true 
    },
    isVerified: { 
        type: Boolean, 
        default: false 
    },

    status: {
        type: String,
        enum: ['pending', 'active', 'suspended'],
        default: 'pending'
    },
    verificationNotes: String,
    verifiedBy: String,
    verificationDate: Date,
    lastLogin: Date
}, {
    timestamps: true
}
);

const Advocate = mongoose.model('Advocate', AdvocateSchema);
const multer = require('multer');
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/cop_documents')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed!'), false);
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Generate OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP via email
const sendEmailOTP = async (email, otp) => {
    const msg = {
        to: email,
        from: process.env.FROM_EMAIL,
        subject: 'Email Verification OTP - Legal Portal',
        html: `
            <h2>Verify Your Email</h2>
            <p>Your OTP for email verification is: <strong>${otp}</strong></p>
            <p>This OTP will expire in 10 minutes.</p>
        `
    };
    
    try {
        await sgMail.send(msg);
        return true;
    } catch (error) {
        console.error('SendGrid Error:', error);
        throw error;
    }
};
// Verify enrollment details
// Verify enrollment details
app.post('/api/advocate/verify-enrollment', async (req, res) => {
    try {
        const { enrollment_no, name, district, date_of_registration } = req.body;

        if (!enrollment_no || !name || !district || !date_of_registration) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        // Convert the incoming MM/DD/YYYY date to M/D/YYYY format (remove leading zeroes)
        const dateParts = date_of_registration.split('/'); // ["03", "01", "2014"]
        const formattedDate = `${parseInt(dateParts[0])}/${parseInt(dateParts[1])}/${dateParts[2]}`; // "3/1/2014"

        console.log('Incoming date:', date_of_registration);
        console.log('Formatted date:', formattedDate);

        const record = await EnrollmentRecord.findOne({
            ENROLLMENT_NO: enrollment_no,
            NAME_OF_ADVOCATE: name,
            DISTRICT: district,
            DATE_OF_REGISTRATION: formattedDate
        });

        if (!record) {
            return res.status(400).json({
                message: 'Enrollment details do not match our records',
                debug: {
                    receivedDate: date_of_registration,
                    formattedDate: formattedDate,
                    query: {
                        ENROLLMENT_NO: enrollment_no,
                        NAME_OF_ADVOCATE: name,
                        DISTRICT: district,
                        DATE_OF_REGISTRATION: formattedDate
                    }
                }
            });
        }

        res.json({
            message: 'Enrollment verified successfully',
            record: {
                enrollment_no: record.ENROLLMENT_NO,
                name: record.NAME_OF_ADVOCATE,
                fathers_name: record.FATHERS_NAME_OF_ADVOCATE,
                district: record.DISTRICT,
                date_of_registration: record.DATE_OF_REGISTRATION
            }
        });
    } catch (error) {
        console.error('Date processing error:', error);
        res.status(500).json({ 
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Register advocate (Step 1: Basic Details)

app.post('/api/advocate/register', upload.single('cop_document'), async (req, res) => {
    try {
        const { 
            enrollment_no, 
            name, 
            email, 
            password, 
            gender, 
            dob, 
            district, 
            practice_details,
            iCOP_number,
            barId
        } = req.body;

        if (!req.file) {
            return res.status(400).json({ message: 'COP document is required' });
        }

        const existingAdvocate = await Advocate.findOne({
            $or: [
                { email }, 
                { enrollment_no },
                { iCOP_number },
                { barId }
            ]
        });

        if (existingAdvocate) {
            return res.status(400).json({
                message: 'Advocate already registered with this email, enrollment number, iCOP number, or Bar ID'
            });
        }

        const emailOTP = generateOTP();
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const advocate = new Advocate({
            advocate_id: 'ADV' + Date.now(),
            enrollment_no,
            name,
            gender,
            dob,
            contact: { email },
            district,
            practice_details,
            email,
            password: hashedPassword,
            emailOTP,
            otpExpiry: new Date(Date.now() + 10 * 60 * 1000),
            iCOP_number,
            barId,
            cop_document: {
                filename: req.file.filename,
                path: req.file.path,
                uploadDate: new Date()
            },
            status: 'pending', // Will remain pending until verified
            isVerified: false
        });

        await advocate.save();
        await sendEmailOTP(email, emailOTP);

        res.status(201).json({
            message: 'Registration initiated. Please verify your email. Account will be activated after document verification.',
            advocate_id: advocate.advocate_id
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
// Verify Email OTP
app.post('/api/advocate/verify-email', async (req, res) => {
    try {
        const { advocate_id, otp } = req.body;
        console.log('Current Server Time (UTC):', new Date().toISOString());

        const advocate = await Advocate.findOne({
            advocate_id,
            emailOTP: otp,
            otpExpiry: { $gt: new Date() }
        });

        if (!advocate) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        console.log('Before update:', advocate);

        // Update verification status
        advocate.isEmailVerified = true;
        advocate.emailOTP = undefined;
        advocate.status = 'pending';
        await advocate.save();

        console.log('After update:', await Advocate.findOne({ advocate_id })); // Ensure changes persist

        res.json({ message: 'Email verified successfully' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/advocate/verify/:advocate_id', async (req, res) => {
    try {
        const { verified, notes } = req.body;
        const advocate = await Advocate.findOne({ advocate_id: req.params.advocate_id });

        if (!advocate) {
            return res.status(404).json({ message: 'Advocate not found' });
        }

        advocate.isVerified = verified;
        advocate.verificationNotes = notes;
        advocate.verificationDate = new Date();
        advocate.status = verified ? 'active' : 'pending';

        await advocate.save();

        res.json({ 
            message: `Advocate ${verified ? 'verified' : 'verification rejected'} successfully`,
            advocate_id: advocate.advocate_id,
            status: advocate.status
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
const TokenBlacklistSchema = new mongoose.Schema({
    token: {
        type: String,
        required: true,
        unique: true
    },
    user_id: {
        type: String,
        required: true
    },
    user_type: {
        type: String,
        required: true,
        enum: ['advocate', 'litigant', 'clerk']
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400
    }
});

const BlacklistedToken = mongoose.model('BlacklistedToken', TokenBlacklistSchema);


// Login
app.post('/api/advocate/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const advocate = await Advocate.findOne({ email });
        if (!advocate) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, advocate.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (!advocate.isEmailVerified) {
            return res.status(401).json({ message: 'Please complete verification process' });
        }

        if (advocate.status !== 'active') {
            return res.status(401).json({ message: 'Account is not active,wait for your verification done by court admin ' });
        }

        // Update last login
        advocate.lastLogin = new Date();
        await advocate.save();

        // Generate JWT token
        const token = jwt.sign(
            {
                advocate_id: advocate.advocate_id,
                email: advocate.email,
                user_type: 'advocate'
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            advocate: {
                advocate_id: advocate.advocate_id,
                name: advocate.name,
                email: advocate.email
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Protected route example
const authenticateToken = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    try {
        const isBlacklisted = await BlacklistedToken.findOne({ token });
        if (isBlacklisted) {
            return res.status(401).json({ message: 'Token has been invalidated' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Invalid token' });
    }
};
app.get('/api/advocate/profile', authenticateToken, async (req, res) => {
    try {
        const advocate = await Advocate.findOne({ advocate_id: req.user.advocate_id })
            .select('-password -emailOTP -mobileOTP');
        
        if (!advocate) {
            return res.status(404).json({ message: 'Advocate not found' });
        }

        res.json({ advocate });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
app.post('/api/advocate/logout', authenticateToken, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        await new BlacklistedToken({
            token,
            user_id: req.user.advocate_id,
            user_type: 'advocate'
        }).save();

        await Advocate.findOneAndUpdate(
            { advocate_id: req.user.advocate_id },
            { lastLogout: new Date() }
        );

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
// Logout from all devices
app.post('/api/advocate/logout-all', authenticateToken, async (req, res) => {
    try {
        const { password } = req.body;
        
        const advocate = await Advocate.findOne({ advocate_id: req.user.advocate_id });
        if (!advocate) {
            return res.status(404).json({ message: 'Advocate not found' });
        }

        const isValidPassword = await bcrypt.compare(password, advocate.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid password' });
        }

        const currentToken = req.headers.authorization?.split(' ')[1];
        await new BlacklistedToken({
            token: currentToken,
            user_id: req.user.advocate_id,
            user_type: 'advocate'
        }).save();

        await Advocate.findOneAndUpdate(
            { advocate_id: req.user.advocate_id },
            { 
                lastLogout: new Date(),
                lastForceLogout: new Date()
            }
        );

        res.json({ message: 'Logged out from all devices successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
// Add this cleanup function at the end of your file
// Cleanup expired blacklisted tokens (can be run via cron job)
const cleanupBlacklistedTokens = async () => {
    try {
        const expiryDate = new Date(Date.now() - 86400 * 1000); // 24 hours ago
        await BlacklistedToken.deleteMany({ createdAt: { $lt: expiryDate } });
    } catch (error) {
        console.error('Token cleanup error:', error);
    }
};
const cron = require('node-cron');

// Run cleanup every day at midnight
cron.schedule('0 0 * * *', () => {
    cleanupBlacklistedTokens();
});
const LitigantSchema = new mongoose.Schema({
    party_id: { type: String, required: true, unique: true },
    party_type: {
        type: String,
        required: true,
        enum: ['plaintiff', 'defendant']
    },
    full_name: { type: String, required: true },
    parentage: { type: String, required: true },
    gender: {
        type: String,
        required: true,
        enum: ['male', 'female', 'other']
    },
    address: { type: String, required: true },
    contact: {
        email: { type: String, required: true, unique: true },
        mobile: { type: String, required: true }
    },
    password: { type: String, required: true },
    isEmailVerified: { type: Boolean, default: false },
    emailOTP: String,
    otpExpiry: Date,
    status: {
        type: String,
        enum: ['pending', 'active', 'suspended'],
        default: 'pending'
    },
    lastLogin: Date,
    lastLogout: Date,

    // Additional fields for case filing
    case_filing_details: {
        relation_type: {
            type: String,
            enum: ['FATHER', 'MOTHER', 'HUSBAND']
        },
        pin: String,
        age: Number,
        caste: String,
        nationality: {
            type: String,
            enum: ['INDIAN', 'OTHER']
        },
        occupation: String,
        subject: String,
        fax: String,
        phone: String
    },
    advocates: [{
        advocate_code: { type: String },
        advocate_name: { type: String }
    }]
}, {
    timestamps: true
});

// Indexes

const Litigant = mongoose.model('Litigant', LitigantSchema);

// Register litigant
app.post('/api/litigant/register', async (req, res) => {
    try {
        const {
            party_type,
            full_name,
            parentage,
            gender,
            address,
            email,
            mobile,
            password
        } = req.body;

        // Validate required fields
        if (!party_type || !full_name || !parentage || !gender || !address || !email || !mobile || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        // Check if email already exists
        const existingLitigant = await Litigant.findOne({
            'contact.email': email
        });

        if (existingLitigant) {
            return res.status(400).json({
                message: 'Email already registered'
            });
        }

        const emailOTP = generateOTP();
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const litigant = new Litigant({
            party_id: 'LIT' + Date.now(),
            party_type,
            full_name,
            parentage,
            gender,
            address,
            contact: {
                email,
                mobile
            },
            password: hashedPassword,
            emailOTP,
            otpExpiry: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
        });

        await litigant.save();
        await sendEmailOTP(email, emailOTP);

        res.status(201).json({
            message: 'Registration initiated. Please verify your email.',
            party_id: litigant.party_id
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Verify Email OTP
app.post('/api/litigant/verify-email', async (req, res) => {
    try {
        const { party_id, otp } = req.body;

        const litigant = await Litigant.findOne({
            party_id,
            emailOTP: otp,
            otpExpiry: { $gt: new Date() }
        });

        if (!litigant) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        // Update verification status
        litigant.isEmailVerified = true;
        litigant.emailOTP = undefined;
        litigant.status = 'active';
        await litigant.save();

        res.json({ message: 'Email verified successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Login
app.post('/api/litigant/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const litigant = await Litigant.findOne({ 'contact.email': email });
        if (!litigant) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, litigant.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (!litigant.isEmailVerified) {
            return res.status(401).json({ message: 'Please complete email verification' });
        }

        if (litigant.status !== 'active') {
            return res.status(401).json({ message: 'Account is not active' });
        }

        // Update last login
        litigant.lastLogin = new Date();
        await litigant.save();

        // Generate JWT token
        const token = jwt.sign(
            {
                party_id: litigant.party_id,
                email: litigant.contact.email,
                user_type: 'litigant'
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            litigant: {
                party_id: litigant.party_id,
                full_name: litigant.full_name,
                email: litigant.contact.email,
                party_type: litigant.party_type
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Protected route for litigant profile
app.get('/api/litigant/profile', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'litigant') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const litigant = await Litigant.findOne({ party_id: req.user.party_id })
            .select('-password -emailOTP');
        
        if (!litigant) {
            return res.status(404).json({ message: 'Litigant not found' });
        }

        res.json({ litigant });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Logout
app.post('/api/litigant/logout', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'litigant') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const token = req.headers.authorization?.split(' ')[1];
        
        await new BlacklistedToken({
            token,
            user_id: req.user.party_id,
            user_type: 'litigant'
        }).save();

        await Litigant.findOneAndUpdate(
            { party_id: req.user.party_id },
            { lastLogout: new Date() }
        );

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
app.post('/api/litigant/logout-all', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'litigant') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { password } = req.body;
        
        const litigant = await Litigant.findOne({ party_id: req.user.party_id });
        if (!litigant) {
            return res.status(404).json({ message: 'Litigant not found' });
        }

        const isValidPassword = await bcrypt.compare(password, litigant.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid password' });
        }

        const currentToken = req.headers.authorization?.split(' ')[1];
        await new BlacklistedToken({
            token: currentToken,
            user_id: req.user.party_id,
            user_type: 'litigant'
        }).save();

        await Litigant.findOneAndUpdate(
            { party_id: req.user.party_id },
            { 
                lastLogout: new Date(),
                lastForceLogout: new Date()
            }
        );

        res.json({ message: 'Logged out from all devices successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
const ClerkSchema = new mongoose.Schema({
    clerk_id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    gender: { 
        type: String,
        enum: ['male', 'female', 'other'],
        required: true 
    },
    district: { type: String, required: true },
    court_name: { type: String, required: true },
    court_no: { type: String, required: true },
    contact: {
        email: { type: String, required: true, unique: true },
        mobile: { type: String, required: true }
    },
    password: { type: String, required: true },
    isEmailVerified: { type: Boolean, default: false },
    emailOTP: String,
    otpExpiry: Date,
    status: {
        type: String,
        enum: ['pending', 'active', 'suspended'],
        default: 'pending'
    },
    lastLogin: Date,
    lastLogout: Date
}, {
    timestamps: true
});

const Clerk = mongoose.model('Clerk', ClerkSchema);
// Register clerk
app.post('/api/clerk/register', async (req, res) => {
    try {
        const {
            name,
            gender,
            district,
            court_name,
            court_no,
            email,
            mobile,
            password
        } = req.body;

        // Validate required fields
        if (!name || !gender || !district || !court_name || !court_no || !email || !mobile || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        // Check if email already exists
        const existingClerk = await Clerk.findOne({
            'contact.email': email
        });

        if (existingClerk) {
            return res.status(400).json({
                message: 'Email already registered'
            });
        }

        const emailOTP = generateOTP();
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const clerk = new Clerk({
            clerk_id: 'CLK' + Date.now(),
            name,
            gender,
            district,
            court_name,
            court_no,
            contact: {
                email,
                mobile
            },
            password: hashedPassword,
            emailOTP,
            otpExpiry: new Date(Date.now() + 10 * 60 * 1000)
        });

        await clerk.save();
        await sendEmailOTP(email, emailOTP);

        res.status(201).json({
            message: 'Registration initiated. Please verify your email.',
            clerk_id: clerk.clerk_id
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Verify Email OTP
app.post('/api/clerk/verify-email', async (req, res) => {
    try {
        const { clerk_id, otp } = req.body;

        const clerk = await Clerk.findOne({
            clerk_id,
            emailOTP: otp,
            otpExpiry: { $gt: new Date() }
        });

        if (!clerk) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        clerk.isEmailVerified = true;
        clerk.emailOTP = undefined;
        clerk.status = 'active';
        await clerk.save();

        res.json({ message: 'Email verified successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Login
app.post('/api/clerk/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const clerk = await Clerk.findOne({ 'contact.email': email });
        if (!clerk) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, clerk.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (!clerk.isEmailVerified) {
            return res.status(401).json({ message: 'Please complete email verification' });
        }

        if (clerk.status !== 'active') {
            return res.status(401).json({ message: 'Account is not active' });
        }

        clerk.lastLogin = new Date();
        await clerk.save();

        const token = jwt.sign(
            {
                clerk_id: clerk.clerk_id,
                email: clerk.contact.email,
                user_type: 'clerk'
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            clerk: {
                clerk_id: clerk.clerk_id,
                name: clerk.name,
                email: clerk.contact.email,
                district: clerk.district,
                court_name: clerk.court_name,
                court_no: clerk.court_no
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get clerk profile
app.get('/api/clerk/profile', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'clerk') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const clerk = await Clerk.findOne({ clerk_id: req.user.clerk_id })
            .select('-password -emailOTP');
        
        if (!clerk) {
            return res.status(404).json({ message: 'Clerk not found' });
        }

        res.json({ clerk });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Logout
app.post('/api/clerk/logout', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'clerk') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const token = req.headers.authorization?.split(' ')[1];
        
        await new BlacklistedToken({
            token,
            user_id: req.user.clerk_id,
            user_type: 'clerk'
        }).save();

        await Clerk.findOneAndUpdate(
            { clerk_id: req.user.clerk_id },
            { lastLogout: new Date() }
        );

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Logout from all devices
app.post('/api/clerk/logout-all', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'clerk') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { password } = req.body;
        
        const clerk = await Clerk.findOne({ clerk_id: req.user.clerk_id });
        if (!clerk) {
            return res.status(404).json({ message: 'Clerk not found' });
        }

        const isValidPassword = await bcrypt.compare(password, clerk.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid password' });
        }

        const currentToken = req.headers.authorization?.split(' ')[1];
        await new BlacklistedToken({
            token: currentToken,
            user_id: req.user.clerk_id,
            user_type: 'clerk'
        }).save();

        await Clerk.findOneAndUpdate(
            { clerk_id: req.user.clerk_id },
            { 
                lastLogout: new Date(),
                lastForceLogout: new Date()
            }
        );

        res.json({ message: 'Logged out from all devices successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
app.get('/api/clerk/dashboard/advocates', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'clerk') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const clerk = await Clerk.findOne({ clerk_id: req.user.clerk_id });
        if (!clerk) {
            return res.status(404).json({ message: 'Clerk not found' });
        }

        // Find advocates in clerk's district
        const advocates = await Advocate.find({
            'practice_details.district': clerk.district
        }).select('-password -emailOTP');

        // Separate verified and unverified advocates
        const verifiedAdvocates = advocates.filter(adv => adv.isVerified);
        const unverifiedAdvocates = advocates.filter(adv => !adv.isVerified);

        res.json({
            verifiedAdvocates,
            unverifiedAdvocates
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
// Get advocate's COP document
app.get('/api/clerk/advocate/cop-document/:advocate_id', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'clerk') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const advocate = await Advocate.findOne({ advocate_id: req.params.advocate_id });
        if (!advocate) {
            return res.status(404).json({ message: 'Advocate not found' });
        }

        const filePath = path.join(__dirname, advocate.cop_document.path);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'Document not found' });
        }

        res.sendFile(filePath);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});
app.post('/api/clerk/verify-advocate/:advocate_id', authenticateToken, async (req, res) => {
    try {
        if (req.user.user_type !== 'clerk') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { verificationDeclaration, notes } = req.body;
        if (!verificationDeclaration) {
            return res.status(400).json({ message: 'Verification declaration is required' });
        }

        const advocate = await Advocate.findOne({ advocate_id: req.params.advocate_id });
        if (!advocate) {
            return res.status(404).json({ message: 'Advocate not found' });
        }

        // Update advocate verification status
        advocate.isVerified = true;
        advocate.verificationNotes = notes;
        advocate.verificationDate = new Date();
        advocate.verifiedBy = req.user.clerk_id;
        advocate.status = 'active';

        await advocate.save();

        // Send email notification to advocate
        const emailMsg = {
            to: advocate.email,
            from: process.env.FROM_EMAIL,
            subject: 'Account Verification Successful - Legal Portal',
            html: `
                <h2>Account Verification Successful</h2>
                <p>Dear ${advocate.name},</p>
                <p>Your advocate account has been verified successfully. You can now access all features of the legal portal.</p>
                <p>Verification Notes: ${notes || 'None'}</p>
            `
        };
        await sgMail.send(emailMsg);

        res.json({
            message: 'Advocate verified successfully',
            advocate_id: advocate.advocate_id,
            status: advocate.status
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


const stateDistrictSchema = new mongoose.Schema({
  state: {
    type: String,
    required: true,
    unique: true
  },
  districts: [{
    type: String,
    required: true
  }]
});

const StateDistrict = mongoose.model('StateDistrict', stateDistrictSchema);
// Get all states
app.get('/api/states', async (req, res) => {
  try {
    const states = await StateDistrict.find({}, 'state');
    res.json(states.map(state => state.state));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get districts by state
app.get('/api/districts/:state', async (req, res) => {
  try {
    const stateData = await StateDistrict.findOne({ state: req.params.state });
    if (!stateData) {
      return res.status(404).json({ message: 'State not found' });
    }
    res.json(stateData.districts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Initialize data
async function initializeData() {
  try {
    await StateDistrict.deleteMany({});
    await StateDistrict.insertMany(statesAndDistricts);
    console.log('Data initialized successfully');
  } catch (error) {
    console.error('Error initializing data:', error);
  }
}
const HearingSchema = new mongoose.Schema({
    hearing_id: { type: String, required: true, unique: true },
    hearing_date: { type: Date, required: true },
    next_hearing_date:{type:Date},
    court_details: {
      court_name: { type: String, required: true },
      court_number: String,
      location: String,
      judges: [{
        name: { type: String, required: true },
        designation: String
      }]
    },
    interim_orders: String,
    status: {
      type: String,
      enum: ['SCHEDULED', 'IN_PROGRESS', 'CONCLUDED', 'ADJOURNED'],
      required: true
    }
  });
  const DocumentSchema = new mongoose.Schema({
    document_id: { type: String, required: true, unique: true },
    document_type: { type: String, required: true },
    file_name: { type: String, required: true },
    file_path: { type: String, required: true },
    uploaded_date: { type: Date, required: true }
  });
  const ContactSchema = new mongoose.Schema({
    phone: String,
    mobile: String,
    email_address: String,
    fax: String
  });
  const LegalCaseSchema = new mongoose.Schema({
    // Court Information
    court: { 
      type: String, 
      required: true,
      enum: ['District & Sessions Court', 'Other']
    },
    case_type: { 
      type: String, 
      required: true,
      enum: ['Civil', 'Criminal']
    },
  
    // Plaintiff/Applicant Details
    plaintiff_details: {
      party_id: { type: String },
      name: { type: String, required: true },
      father_mother_husband: { type: String },
      address: { type: String },
      pin: { type: String },
      sex: { type: String },
      age: { type: Number },
      caste: { type: String },
      nationality: { type: String },
      if_other_mention: { type: String },
      occupation: { type: String },
      email: { 
        type: String, 
        match: [/^\w+([.-]?\w+)@\w+([.-]?\w+)(\.\w{2,3})+$/, 'Please fill a valid email address']
      },
      phone: { type: String },
      mobile: { type: String },
      fax: { type: String },
      subject: { type: String },
      advocate_id: { type: String },
      advocate: { type: String }
    },
  
    // Respondent/Opponent Details
    respondent_details: {
      party_id: { type: String },
      name: { type: String, required: true },
      father_mother_husband: { type: String },
      address: { type: String },
      pin: { type: String },
      sex: { type: String },
      age: { type: Number },
      caste: { type: String },
      nationality: { type: String },
      if_other_mention: { type: String },
      occupation: { type: String },
      email: { 
        type: String, 
        match: [/^\w+([.-]?\w+)@\w+([.-]?\w+)(\.\w{2,3})+$/, 'Please fill a valid email address']
      },
      phone: { type: String },
      mobile: { type: String },
      fax: { type: String },
      subject: { type: String },
      advocate_id: { type: String },
      advocate: { type: String }
    },
  
    // Additional Criminal-Specific Details
    police_station_details: {
      police_station: { type: String },
      fir_no: { type: String },
      fir_year: { type: Number },
      date_of_offence: { type: Date }
    },
  
    // Lower Court Details
    lower_court_details: {
      court_name: { type: String },
      case_no: { type: String },
      decision_date: { type: Date }
    },
  
    // Main Matter Details
    main_matter_details: {
      case_type: { type: String },
      case_no: { type: String },
      year: { type: Number }
    },
  
    // Hearing Management
    hearings: [{
      hearing_date: { type: Date },
      hearing_type: { 
        type: String, 
        enum: ['Initial', 'Intermediate', 'Final', 'Adjournment'] 
      },
      remarks: { type: String },
      next_hearing_date: { type: Date }
    }],
  
    // Case Status
    status: {
      type: String,
      enum: [
        'Filed', 
        'Pending', 
        'Under Investigation', 
        'Hearing in Progress', 
        'Awaiting Judgment', 
        'Disposed', 
        'Appealed'
      ],
      default: 'Filed'
    },
  
    // Case Approval
    case_approved: { 
      type: Boolean, 
      default: false 
    },
    case_num: { 
        type: String,
        unique: true,
      },
      case_no: {
        type: String,
        unique: true,
        sparse: true  // This allows multiple null values
    },
    // Office Use Details
    for_office_use_only: {
      case_type: { type: String },
      filing_no: { type: String },
      filing_date: { type: Date },
      objection_red_date: { type: Date },
      objection_compliance_date: { type: Date },
      registration_no: { type: String },
      registration_date: { type: Date },
      listing_date: { type: Date },
      court_allotted: { type: String },
      allocation_date: { type: Date },
      case_code: { type: String },
      
      // Additional fields for Criminal Cases
      filing_done_by: { type: String },
      objection_raised_by: { type: String },
      registration_done_by: { type: String },
      allocation_done_by: { type: String }
    },
  
    // Timestamps
    created_at: { type: Date, default: Date.now },
    last_updated: { type: Date, default: Date.now }
  }, {
    timestamps: true
  });
  
  // Pre-save middleware to update last_updated
  LegalCaseSchema.pre('save', function(next) {
    this.last_updated = Date.now();
    next();
  });
  
  const LegalCase = mongoose.model('LegalCase', LegalCaseSchema);
  const generateCNRFromCaseData = async (caseData) => {
    const typePrefix = caseData.case_type === 'Civil' ? 'CL' : 'CM';
    const year = new Date().getFullYear().toString();
    
    // Function to generate a unique serial
    const generateSerial = () => {
        // Get nanosecond timestamp
        const hrTime = process.hrtime();
        const timestamp = hrTime[0] * 1000000000 + hrTime[1];
        
        // Convert to base 36 and take last 2 digits
        const timeComponent = timestamp.toString(36).slice(-2);
        
        // Generate 2 random digits
        const randomComponent = Math.floor(Math.random() * 100).toString().padStart(2, '0');
        
        // Combine them to create a 4-digit serial
        return (timeComponent + randomComponent).slice(-4).toUpperCase();
    };

    // Try to generate a unique CNR up to 5 times
    for (let attempts = 0; attempts < 5; attempts++) {
        const serialNumber = generateSerial();
        const cnrNumber = `${typePrefix}${year}${serialNumber}`;
        
        // Check if this CNR exists
        const existingCase = await LegalCase.findOne({ case_num: cnrNumber });
        
        if (!existingCase) {
            return cnrNumber;
        }
        
        // Add small delay before retry
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // If all attempts fail, use milliseconds + random as last resort
    const lastResortSerial = (Date.now() % 10000).toString().padStart(4, '0');
    return `${typePrefix}${year}${lastResortSerial}`;
};

app.post('/api/filecase/litigant',authenticateToken, async (req, res) => {
    let retryCount = 0;
    const maxRetries = 3;

    async function attemptCaseCreation() {
        try {
            const {
                court,
                case_type,
                plaintiff_details,
                respondent_details,
                police_station_details,
                lower_court_details,
                main_matter_details,
                hearings,
                status,
                case_approved,
                case_no 
            } = req.body;

            if (!court || !case_type || !plaintiff_details || !respondent_details) {
                return res.status(400).json({ message: 'Missing required fields' });
            }
            plaintiff_details.party_id = req.user.party_id;

            // Generate unique CNR
            const cnrNumber = await generateCNRFromCaseData({
                case_type
            });

            const newCase = new LegalCase({
                court,
                case_type,
                plaintiff_details,
                respondent_details,
                police_station_details,
                lower_court_details,
                main_matter_details,
                hearings,
                status,
                case_approved: case_approved || false,
                case_num: cnrNumber
                ,case_no: cnrNumber  
            });

            await newCase.save();

            return res.status(201).json({
                message: 'Case filed successfully',
                case: newCase,
                case_num:cnrNumber,
                case_no:cnrNumber
            });

        } catch (error) {
            console.error('Error in case filing:', error);
            
            if (error.code === 11000 && retryCount < maxRetries) {
                retryCount++;
                console.log(`Retry attempt ${retryCount}`);
                // Wait for a small random interval before retrying
                await new Promise(resolve => 
                    setTimeout(resolve, Math.random() * 100)
                );
                return attemptCaseCreation();
            }
            
            throw error;
        }
    }

    try {
        await attemptCaseCreation();
    } catch (error) {
        console.error('Final error in case filing:', error);
        if (error.code === 11000) {
            res.status(409).json({
                message: 'Unable to generate unique case number after multiple attempts. Please try again.'
            });
        } else {
            res.status(500).json({
                message: 'Server error while filing case'
            });
        }
    }
});
  
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
