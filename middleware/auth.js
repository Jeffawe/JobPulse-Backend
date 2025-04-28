import jwt from 'jsonwebtoken';

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = decoded.userId;
      next();
    } catch (error) {
      return res.status(403).json({ error: 'Invalid token' });
    }
  } else {
    const userID = req.headers['userid']; // Note: HTTP headers are case-insensitive and usually lowercased
    
    if (!userID) {
      // No userID header found
      return res.status(401).json({ error: 'No authentication provided' });
    }
    
    // UserID header exists, set it on the request object
    req.userId = userID;
    next();
  }
};