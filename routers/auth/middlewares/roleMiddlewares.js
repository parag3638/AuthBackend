const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).send('You are not authorized to access this route');
    }
    next();
  };
};

module.exports = authorizeRoles;
