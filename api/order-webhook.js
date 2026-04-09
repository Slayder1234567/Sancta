const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');
const https = require('https');

// ─── AliExpress DS API helper ───────────────────────────────────────────────

function aliexpressRequest(method, params) {
  return new Promise((resolve, reject) => {
    const appKey    = process.env.ALIEXPRESS_APP_KEY;
    const appSecret = process.env.ALIEXPRESS_APP_SECRET;
    const token     = process.env.ALIEXPRESS_ACCESS_TOKEN;

    const allParams = {
      method,
      app_key:      appKey,
      session:      token,
      timestamp:    new Date().toISOString().replace('T', ' ').slice(0, 19),
      format:       'json',
      v:            '2.0',
      sign_method:  'md5',
      ...params,
    };

    // Sign the request
    const keys   = Object.keys(allParams).sort();
    let   signStr = appSecret;
    for (const k of keys) signStr += k + allParams[k];
    signStr += appSecret;
    allParams.sign = crypto.createHash('md5').update(signStr).digest('hex').toUpperCase();

    const query = new URLSearchParams(allParams).toString();
    const url   = `https://api-sg.aliexpress.com/sync?${query}`;

    https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Product & SKU mapping ───────────────────────────────────────────────────

// AliExpress DS product IDs
const ALIEXPRESS_PRODUCTS = {
  'The Cross': { product_id: '1005007562171783' },
  'The Ring':  { product_id: '1005007975677041' },
};

// Ring SKU IDs per color + size combination.
// Fill these in from the AliExpress DS API product details endpoint once approved.
// Format: 'Color-Size' → sku_id string
const RING_SKU_MAP = {
  'Silver-6':    '', 'Silver-7':    '', 'Silver-8':    '', 'Silver-9':    '', 'Silver-10':    '',
  'Gold-6':      '', 'Gold-7':      '', 'Gold-8':      '', 'Gold-9':      '', 'Gold-10':      '',
  'Rose Gold-6': '', 'Rose Gold-7': '', 'Rose Gold-8': '', 'Rose Gold-9': '', 'Rose Gold-10': '',
};

function getSkuId(item) {
  if (item.name === 'The Ring') {
    const key = `${item.color}-${item.size}`;
    return RING_SKU_MAP[key] || '';
  }
  // The Cross — single 40cm variant
  return '';
}

// ─── Place order on AliExpress ───────────────────────────────────────────────

async function placeAliexpressOrder(session) {
  const shipping = session.shipping_details;
  const addr     = shipping.address;

  // Parse cart from Stripe metadata (set by create-checkout.js)
  let cartItems = [];
  try {
    cartItems = JSON.parse(session.metadata?.cart || '[]');
  } catch (e) {
    // Fallback: single Cross order (legacy sessions without metadata)
    cartItems = [{ name: 'The Cross', size: '40 cm', color: '', qty: 1 }];
  }

  const orderItems = cartItems.map(item => {
    const product = ALIEXPRESS_PRODUCTS[item.name];
    if (!product) {
      console.warn(`Unknown product: ${item.name} — skipping`);
      return null;
    }
    return {
      product_id:              product.product_id,
      sku_id:                  getSkuId(item),
      quantity:                item.qty,
      logistics_service_name:  'CAINIAO_STANDARD',
      order_memo:              `Cincta order — ${item.name}${item.color ? ' · ' + item.color : ''}${item.size ? ' · Size ' + item.size : ''}`,
    };
  }).filter(Boolean);

  if (orderItems.length === 0) {
    throw new Error('No valid AliExpress products in order');
  }

  const body = {
    param_place_order_request4_open_api_d_t_o: JSON.stringify({
      out_order_id:      session.id,
      logistics_address: {
        contact_person:  shipping.name,
        address:         addr.line1 + (addr.line2 ? ' ' + addr.line2 : ''),
        city:            addr.city,
        province:        addr.state || addr.city,
        country:         addr.country,
        zip:             addr.postal_code,
        phone_country:   '',
        mobile_no:       session.customer_details?.phone || '',
        email:           session.customer_details?.email || '',
      },
      product_items: orderItems,
    }),
  };

  return aliexpressRequest('aliexpress.ds.order.create', body);
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // Collect raw body for Stripe signature verification
  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  let   event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;

  // Skip if not paid
  if (session.payment_status !== 'paid') {
    return res.status(200).json({ received: true });
  }

  try {
    const result = await placeAliexpressOrder(session);
    console.log('AliExpress order result:', JSON.stringify(result));

    if (result?.aliexpress_ds_order_create_response?.result?.is_success) {
      const orderId = result.aliexpress_ds_order_create_response.result.order_id;
      console.log('Order placed successfully. AliExpress order ID:', orderId);
    } else {
      console.error('AliExpress order failed:', JSON.stringify(result));
    }
  } catch (err) {
    console.error('Failed to place AliExpress order:', err.message);
  }

  res.status(200).json({ received: true });
};
