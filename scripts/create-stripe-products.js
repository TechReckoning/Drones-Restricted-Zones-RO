'use strict';

// One-off: create the Pro product + two RON recurring prices in your Stripe
// account (test mode when STRIPE_SECRET_KEY is a test key). Prints the price IDs
// to paste into .env. Safe to re-run — it creates NEW prices each time, so only
// run it when you actually need fresh price IDs.
//
//   node scripts/create-stripe-products.js

require('dotenv').config();
const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set in .env');
  process.exit(1);
}
const stripe = new Stripe(key);

(async () => {
  const product = await stripe.products.create({
    name: 'Drones Restricted Zones RO — Pro',
    description: 'Flying-zone drawing, overlap analysis, KML export and saved history.',
  });

  const monthly = await stripe.prices.create({
    product: product.id,
    currency: 'ron',
    unit_amount: 5000, // 50.00 RON
    recurring: { interval: 'month' },
    nickname: 'Pro Monthly',
  });

  const annual = await stripe.prices.create({
    product: product.id,
    currency: 'ron',
    unit_amount: 55000, // 550.00 RON
    recurring: { interval: 'year' },
    nickname: 'Pro Annual',
  });

  console.log(`\nCreated product ${product.id} with prices.\nAdd these to your .env:\n`);
  console.log(`STRIPE_PRICE_MONTHLY=${monthly.id}`);
  console.log(`STRIPE_PRICE_ANNUAL=${annual.id}\n`);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
