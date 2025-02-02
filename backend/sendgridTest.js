// Load environment variables from .env file
require('dotenv').config();

// Import the SendGrid mail module
const sgMail = require('@sendgrid/mail');

// Set the SendGrid API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Email details
const msg = {
  to: 'aaditiyatyagi123@gmail.com', // Change to your recipient email
  from: process.env.FROM_EMAIL, // Your verified sender email
  subject: 'SendGrid API Test',
  text: '02036',
};

// Send the email
sgMail
  .send(msg)
  .then(() => {
    console.log('Email sent successfully!');
  })
  .catch((error) => {
    console.error('Error sending email:', error);
  });
