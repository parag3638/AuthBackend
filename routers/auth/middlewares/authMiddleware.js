const express = require('express');
const router = express.Router();

const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  let token;
  let authHeader = req.headers.authorization || req.headers.Authorization;

  if (authHeader && authHeader.startsWith('Bearer')) {
    token = authHeader.split(' ')[1];

    if (!token) return res.status(401).send('No Token Provided');
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (error) {
    console.error(error);
    res.status(400).send('Invalid Token');
  }
};

module.exports = verifyToken;
