require('dotenv').config(); // Load environment variables
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const port = 3001;

app.use(express.json());

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('test_table').select('*');
    if (error) throw error;
    res.send(`Welcome to Vimana Backend! Supabase test: ${JSON.stringify(data)}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Vimana backend server running at http://localhost:${port}`);
});