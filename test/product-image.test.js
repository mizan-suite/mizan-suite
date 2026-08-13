// test/product-image.test.js
// Product image upload: storing a base64 data URL on the product, updating it,
// clearing it, and rejecting invalid/oversized images.

const test = require('node:test');
const assert = require('node:assert');
const { startTestServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(() => { if (srv) srv.shutdown(); });

// A valid tiny PNG as a base64 data URL (1x1 pixel).
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AR//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AR//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';

// A data URL whose decoded size exceeds the 1 MB cap (~1.05 MB decoded).
function oversizedImage() {
  return 'data:image/png;base64,' + 'A'.repeat(1400000);
}

async function loginAsOwner() {
  await srv.request('POST', '/api/users', { name: 'Owner', pin: '123456' });
  const r = await srv.request('POST', '/api/auth/login', { name: 'Owner', pin: '123456' });
  const cookie = r.setCookie().split(';')[0];
  return { cookie };
}

test('product image: stored on create and returned by the API', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Photo Product',
    image: TINY_PNG
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.image, TINY_PNG);
  assert.ok(r.data.id);

  const got = await srv.request('GET', `/api/products/${r.data.id}`, undefined, { cookie });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.data.image, TINY_PNG);
});

test('product image: a product without an image has image null', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', { name: 'Plain Product' }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.image, null);
});

test('product image: jpeg data URLs are accepted', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Jpeg Product',
    image: TINY_JPEG
  }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.ok(r.data.image.startsWith('data:image/jpeg;base64,'));
});

test('product image: non-data-URL strings are rejected', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Bad Image',
    image: 'myfile.jpg'
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('product image: non-image data URLs are rejected', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Bad Image 2',
    image: 'data:text/plain;base64,QUJD'
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('product image: oversized images are rejected', async () => {
  const { cookie } = await loginAsOwner();
  const r = await srv.request('POST', '/api/products', {
    name: 'Huge Image',
    image: oversizedImage()
  }, { cookie });
  assert.strictEqual(r.status, 400);
});

test('product image: PUT replaces the image and omitted image keeps it', async () => {
  const { cookie } = await loginAsOwner();
  const created = await srv.request('POST', '/api/products', {
    name: 'Editable Photo',
    image: TINY_PNG
  }, { cookie });
  const id = created.data.id;

  // Omitting `image` must NOT wipe the stored image.
  const partial = await srv.request('PUT', `/api/products/${id}`, { name: 'Editable Photo v2' }, { cookie });
  assert.strictEqual(partial.status, 200);
  assert.strictEqual(partial.data.image, TINY_PNG);

  // Changing it to a new image replaces it.
  const replaced = await srv.request('PUT', `/api/products/${id}`, { name: 'Editable Photo v2', image: TINY_JPEG }, { cookie });
  assert.strictEqual(replaced.status, 200);
  assert.strictEqual(replaced.data.image, TINY_JPEG);

  // An empty image string clears it.
  const cleared = await srv.request('PUT', `/api/products/${id}`, { name: 'Editable Photo v2', image: '' }, { cookie });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(cleared.data.image, null);
});

test('product image: an invalid image on PUT is rejected without changing it', async () => {
  const { cookie } = await loginAsOwner();
  const created = await srv.request('POST', '/api/products', {
    name: 'Keep Photo',
    image: TINY_PNG
  }, { cookie });
  const id = created.data.id;

  const bad = await srv.request('PUT', `/api/products/${id}`, { name: 'Keep Photo', image: 'nope.png' }, { cookie });
  assert.strictEqual(bad.status, 400);

  const got = await srv.request('GET', `/api/products/${id}`, undefined, { cookie });
  assert.strictEqual(got.data.image, TINY_PNG);
});

test('product image: listed and paged endpoints expose the image', async () => {
  const { cookie } = await loginAsOwner();
  await srv.request('POST', '/api/products', { name: 'Listed Photo', image: TINY_PNG }, { cookie });

  const list = await srv.request('GET', '/api/products', undefined, { cookie });
  assert.strictEqual(list.status, 200);
  const found = list.data.find(p => p.name === 'Listed Photo');
  assert.ok(found);
  assert.strictEqual(found.image, TINY_PNG);

  const paged = await srv.request('GET', '/api/products/paged?per_page=500', undefined, { cookie });
  assert.strictEqual(paged.status, 200);
  const foundPaged = paged.data.items.find(p => p.name === 'Listed Photo');
  assert.ok(foundPaged);
  assert.strictEqual(foundPaged.image, TINY_PNG);
});
