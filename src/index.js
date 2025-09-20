require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { Clerk } = require('@clerk/clerk-sdk-node');
const app = express();
const port = 3001;

app.use(express.json());

const allowedOrigins = ['http://localhost:3000'];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// Supabase admin client for user sync and operations
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const clerk = new Clerk({ secretKey: process.env.CLERK_SECRET_KEY });

// Middleware to verify Clerk JWT and extract user ID
const authenticateClerk = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Authorization header missing or invalid');
  }

  const token = authHeader.split(' ')[1];
  try {
    const user = await clerk.verifyToken(token);
    req.userId = user.sub; // Clerk user ID (sub)
    req.clerkToken = token; // Store token for Supabase
    next();
  } catch (error) {
    console.error('Clerk verification error:', error);
    res.status(401).send('Invalid token');
  }
};

// GET endpoint for rides
app.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('rides').select('*');
    if (error) throw error;
    res.send(`Welcome to Vimana Backend! Rides data: ${JSON.stringify(data)}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// GET endpoint for user profile
app.get('/profile', authenticateClerk, async (req, res) => {
  try {
    const user_id = req.userId; // Clerk's sub
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('name, email, role, phone')
      .eq('clerk_id', user_id)
      .single();

    if (error) {
      console.error('Error fetching profile:', error);
      throw error;
    }

    if (!data) {
      return res.status(404).send('User profile not found');
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('Error in /profile:', error.stack);
    res.status(500).send(`Error fetching profile: ${error.message}`);
  }
});

// PUT endpoint for updating user profile
app.put('/profile', authenticateClerk, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) {
      return res.status(400).send('Name is required.');
    }

    const user_id = req.userId; // Clerk's sub
    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ name, phone, updated_at: new Date().toISOString() })
      .eq('clerk_id', user_id)
      .select('name, email, role, phone')
      .single();

    if (error) {
      console.error('Error updating profile:', error);
      throw error;
    }

    if (!data) {
      return res.status(404).send('User profile not found');
    }

    res.status(200).json(data);
  } catch (error) {
    console.error('Error in /profile update:', error.stack);
    res.status(500).send(`Error updating profile: ${error.message}`);
  }
});

// POST endpoint for ride booking
app.post('/book-ride', authenticateClerk, async (req, res) => {
  try {
    const { pickup_location, dropoff_location } = req.body;
    if (!pickup_location || !dropoff_location) {
      return res.status(400).send('Pickup and dropoff locations are required.');
    }

    const user_id = req.userId; // Clerk's sub
    const clerkToken = req.clerkToken; // Clerk JWT
    console.log('Attempting to sync user with clerk_id:', user_id);

    // Sync Clerk user with users table using admin client
    const clerkUser = await clerk.users.getUser(user_id);
    const { data: existingUser, error: userError } = await supabaseAdmin
      .from('users')
      .select('clerk_id')
      .eq('clerk_id', user_id)
      .single();

    if (userError && userError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Error checking user:', userError);
      throw userError;
    }

    if (!existingUser) {
      console.log('User not found, creating new user...');
      const { data: newUser, error: insertError } = await supabaseAdmin
        .from('users')
        .insert({
          clerk_id: user_id,
          email: clerkUser.emailAddresses[0]?.emailAddress || 'unknown@example.com',
          name: clerkUser.firstName || 'Unknown',
          role: 'rider',
        })
        .select();
      if (insertError) {
        console.error('Error inserting user:', insertError);
        throw insertError;
      }
      console.log('User synced:', newUser[0]);
    } else {
      console.log('User already exists:', existingUser);
    }

    console.log('Attempting to insert ride with user_id:', user_id, 'locations:', { pickup_location, dropoff_location });

    // Use admin client for ride insertion to bypass RLS issues
    const { data, error } = await supabaseAdmin
      .from('rides')
      .insert({
        user_id,
        pickup_location,
        dropoff_location,
      })
      .select();

    if (error) {
      console.error('Supabase Error Details:', error.code, error.message, error.details);
      throw error;
    }
    console.log('Ride inserted successfully:', data[0]);
    res.status(201).json(data[0]);
  } catch (error) {
    console.error('Error in /book-ride:', error.stack);
    res.status(500).send(`Error booking ride: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Vimana backend server running at http://localhost:${port}`);
});