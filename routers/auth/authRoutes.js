const express = require('express');
const { login } = require('./controllers/authcontroller.js');
const { register } = require('./controllers/authcontroller.js');

const router = express.Router();


module.exports = function () {

    router.post('/login', login);
    router.post('/register', register);

    return router;
}
