const express = require('express');
const app = express();
const port = 3001;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Welcome to Vimana Backend!');
});

app.listen(port, () => {
  console.log(`Vimana backend server running at http://localhost:${port}`);
});