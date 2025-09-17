require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// GET endpoint
app.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('rides').select('*');
    if (error) throw error;
    res.send(`Welcome to Vimana Backend! Rides data: ${JSON.stringify(data)}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// POST endpoint for ride booking
app.post('/book-ride', async (req, res) => {
  try {
    const { pickup_location, dropoff_location } = req.body;
    if (!pickup_location || !dropoff_location) {
      return res.status(400).send('Pickup and dropoff locations are required.');
    }

    // Use the same UUID as the test user
    const user_id = '550e8400-e29b-41d4-a716-446655440000'; // Updated from temp-user-id

    console.log('Attempting to insert ride with user_id:', user_id, 'locations:', { pickup_location, dropoff_location });

    const { data, error } = await supabase
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