'use strict';

const { handleRequest } = require('../server');

module.exports = async function handler(req, res) {
  return handleRequest(req, res);
};
