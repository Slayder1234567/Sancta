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

// ─── Place order on AliExpress ───────────────────────────────────────────────

async function placeAliexpressOrder(session) {
  const shipping = session.shipping_details;
  const addr     = shipping.address;

  const orderItems = [{
    product_id:          '1005007562171783',
    sku_id:              '',          // populated via API once approved; 40cm only variant
    quantity:            1,
    logistics_service_name: 'CAINIAO_STANDARD',
    order_memo:          'Cincta order — handle with care',
  }];

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

  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  let   event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
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
