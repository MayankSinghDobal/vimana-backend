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

// Supabase clients
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const clerk = new Clerk({ secretKey: process.env.CLERK_SECRET_KEY });

// Middleware to verify Clerk JWT and extract user ID
const authenticateClerk = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or invalid' });
  }

  const token = authHeader.split(' ')[1];
  
  // Check if token is valid format
  if (!token || token === 'null' || token === 'undefined' || token.split('.').length !== 3) {
    return res.status(401).json({ error: 'Invalid token format' });
  }

  try {
    const user = await clerk.verifyToken(token);
    req.userId = user.sub; // Clerk user ID (sub)
    req.clerkToken = token; // Store token for Supabase
    next();
  } catch (error) {
    console.error('Clerk verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// FIXED: Helper function to ensure user exists and sync with latest Clerk data
const ensureUserExists = async (userId, requestedRole = null) => {
  try {
    // Fetch Clerk user data
    const clerkUser = await clerk.users.getUser(userId);
    const clerkRole = clerkUser.unsafeMetadata?.role || 'rider';
    
    console.log(`Clerk user ${userId} has role: ${clerkRole}, requested: ${requestedRole}`);

    // Check if user exists in Supabase
    const { data: existingUser, error: checkError } = await supabaseAdmin
      .from('users')
      .select('clerk_id, role, name, email')
      .eq('clerk_id', userId)
      .single();

    // If user doesn't exist, create with requested role or Clerk role
    if (checkError && checkError.code === 'PGRST116') {
      console.log('User not found, creating new user');
      
      const roleToUse = requestedRole || clerkRole;
      
      // Update Clerk metadata if we're using a different role
      if (requestedRole && requestedRole !== clerkRole) {
        await clerk.users.updateUserMetadata(userId, {
          unsafeMetadata: {
            ...clerkUser.unsafeMetadata,
            role: requestedRole
          }
        });
        console.log(`Updated Clerk metadata from ${clerkRole} to ${requestedRole}`);
      }
      
      const { data: newUser, error: insertError } = await supabaseAdmin
        .from('users')
        .insert({
          clerk_id: userId,
          email: clerkUser.emailAddresses[0]?.emailAddress || 'unknown@example.com',
          name: clerkUser.firstName || 'Unknown',
          role: roleToUse,
        })
        .select('clerk_id, role, name, email')
        .single();

      if (insertError) {
        console.error('Error creating user:', insertError);
        throw new Error('Failed to create user profile');
      }

      return newUser;
    }

    // User exists - handle role switching logic
    if (existingUser) {
      // If a specific role is requested and it's different from current role
      if (requestedRole && requestedRole !== existingUser.role) {
        console.log(`Role switch requested: ${existingUser.role} -> ${requestedRole}`);
        
        // Update both Clerk and Supabase
        await clerk.users.updateUserMetadata(userId, {
          unsafeMetadata: {
            ...clerkUser.unsafeMetadata,
            role: requestedRole
          }
        });
        
        const { data: updatedUser, error: updateError } = await supabaseAdmin
          .from('users')
          .update({ 
            role: requestedRole,
            updated_at: new Date().toISOString()
          })
          .eq('clerk_id', userId)
          .select('clerk_id, role, name, email')
          .single();

        if (updateError) {
          console.error('Error updating user role:', updateError);
          throw new Error('Failed to update user role');
        }
        
        return updatedUser;
      }
      
      // No role change requested, return existing user
      return existingUser;
    }

    throw new Error('Unexpected database state');
  } catch (error) {
    console.error('Error ensuring user exists:', error);
    throw error;
  }
};
// GET endpoint for rides (all rides, for testing)
app.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('rides').select('*');
    if (error) throw error;
    res.send(`Welcome to Vimana Backend! Rides data: ${JSON.stringify(data)}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// GET endpoint for profile with role sync
app.get('/profile', authenticateClerk, async (req, res) => {
  try {
    const user_id = req.userId;
    console.log('Fetching profile for user:', user_id);

    // Don't force sync, just ensure user exists
    const user = await ensureUserExists(user_id);
    
    // Fetch complete profile
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('name, email, role, phone, vehicle_number, license_number')
      .eq('clerk_id', user_id)
      .single();

    if (error) {
      console.error('Error fetching profile:', error);
      return res.status(500).json({ error: 'Failed to fetch profile' });
    }

    console.log('Profile fetched:', data);
    res.json(data);
  } catch (error) {
    console.error('Error in /profile:', error);
    res.status(500).json({ error: 'Error fetching profile' });
  }
});

// PUT endpoint for updating user profile
app.put('/profile', authenticateClerk, async (req, res) => {
  try {
    const { name, phone, role, vehicle_number, license_number } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    
    if (role && !['rider', 'driver'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "rider" or "driver".' });
    }
    
    if (role === 'driver' && (!vehicle_number || !license_number)) {
      return res.status(400).json({ 
        error: 'Vehicle number and license number are required for drivers.' 
      });
    }

    const user_id = req.userId;
    
    console.log('Profile update request:', { user_id, name, phone, role });
    
    // If role is being updated, also update Clerk metadata
    if (role) {
      try {
        const clerkUser = await clerk.users.getUser(user_id);
        await clerk.users.updateUserMetadata(user_id, {
          unsafeMetadata: {
            ...clerkUser.unsafeMetadata,
            role: role
          }
        });
        console.log('Updated Clerk metadata with role:', role);
      } catch (clerkError) {
        console.error('Error updating Clerk metadata:', clerkError);
        // Don't fail the request if Clerk update fails, but log it
      }
    }
    
    // Ensure user exists and sync
    await ensureUserExists(user_id, true);
    
    const updateData = {
      name,
      phone,
      updated_at: new Date().toISOString(),
    };

    if (role) {
      updateData.role = role;
      updateData.vehicle_number = role === 'driver' ? vehicle_number : null;
      updateData.license_number = role === 'driver' ? license_number : null;
    }

    console.log('Updating profile for user:', user_id, 'with data:', updateData);

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(updateData)
      .eq('clerk_id', user_id)
      .select('name, email, role, phone, vehicle_number, license_number')
      .single();

    if (error) {
      console.error('Error updating profile:', error);
      throw error;
    }

    if (!data) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    console.log('Profile updated successfully:', data);
    res.status(200).json(data);
    
  } catch (error) {
    console.error('Error in /profile update:', error);
    res.status(500).json({ 
      error: 'Error updating profile', 
      message: error.message 
    });
  }
});

// GET endpoint for rides
app.get('/rides', authenticateClerk, async (req, res) => {
  try {
    const userId = req.userId;
    console.log('Fetching rides for user:', userId);

    // Don't force role sync here
    const user = await ensureUserExists(userId);
    
    console.log('User role for rides fetch:', user.role);

    let query = supabaseAdmin.from('rides').select('*');

    if (user.role === 'rider') {
      query = query.eq('user_id', userId);
    } else if (user.role === 'driver') {
      query = query.eq('driver_id', userId);
    } else {
      return res.status(403).json({ 
        error: 'Invalid user role',
        currentRole: user.role 
      });
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching rides:', error);
      throw error;
    }

    console.log(`Found ${data.length} rides for ${user.role}:`, userId);
    res.json(data);
  } catch (error) {
    console.error('Error fetching rides:', error);
    res.status(500).json({ 
      error: 'Failed to fetch rides',
      message: error.message 
    });
  }
});
// POST endpoint for ride booking
app.post('/book-ride', authenticateClerk, async (req, res) => {
  try {
    const { pickup_location, dropoff_location } = req.body;
    if (!pickup_location || !dropoff_location) {
      return res.status(400).json({ error: 'Pickup and dropoff locations are required.' });
    }

    const user_id = req.userId;
    console.log('Booking ride for user:', user_id);

    // Ensure user exists
    await ensureUserExists(user_id);

    // Book the ride using admin client (bypasses RLS)
    const { data: rideData, error: rideError } = await supabaseAdmin
      .from('rides')
      .insert({
        user_id,
        pickup_location,
        dropoff_location,
        status: 'requested'
      })
      .select()
      .single();

    if (rideError) {
      console.error('Supabase Ride Error:', rideError);
      return res.status(500).json({ error: 'Failed to book ride' });
    }
    
    console.log('Ride booked successfully:', rideData);
    res.status(201).json(rideData);
    
  } catch (error) {
    console.error('Error in /book-ride:', error);
    res.status(500).json({ 
      error: 'Error booking ride', 
      message: error.message 
    });
  }
});
app.post('/switch-role', authenticateClerk, async (req, res) => {
  try {
    const { role } = req.body;
    const user_id = req.userId;
    
    if (!role || !['rider', 'driver'].includes(role)) {
      return res.status(400).json({ error: 'Valid role (rider/driver) is required' });
    }
    
    console.log(`Role switch request for ${user_id}: ${role}`);
    
    // Use ensureUserExists with requested role to handle the switch
    const updatedUser = await ensureUserExists(user_id, role);
    
    res.json({ 
      success: true, 
      message: `Role switched to ${role}`,
      user: updatedUser 
    });
    
  } catch (error) {
    console.error('Error switching role:', error);
    res.status(500).json({ 
      error: 'Failed to switch role',
      message: error.message 
    });
  }
});


app.listen(port, () => {
  console.log(`Vimana backend server running at http://localhost:${port}`);
});