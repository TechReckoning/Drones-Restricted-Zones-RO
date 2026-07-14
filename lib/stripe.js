'use strict';

// Stripe helper. `stripe` is null when STRIPE_SECRET_KEY is unset, so the app
// runs fine without billing configured (pro features then fall back to the
// trial-only / accounts-only behaviour).

const Stripe = require('stripe');

const SECRET = process.env.STRIPE_SECRET_KEY || '';
const stripe = SECRET ? new Stripe(SECRET) : null;

module.exports = {
  stripe,
  configured: () => Boolean(stripe),
  PRICE_MONTHLY: process.env.STRIPE_PRICE_MONTHLY || '',
  PRICE_ANNUAL: process.env.STRIPE_PRICE_ANNUAL || '',
  WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  PRICES: {
    monthly: { amount: 5000, label: '50 RON / month' },
    annual: { amount: 55000, label: '550 RON / year' },
  },
};
