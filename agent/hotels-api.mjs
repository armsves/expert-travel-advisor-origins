import { Impit } from 'impit';

const GRAPHQL = 'https://www.hotels.com/graphql';
const LISTING_HASH = '9fe4a0908a10b7068669f9690c19fa4da8103b2b51b5c240bfc1bac9f6fdc2e5';
const OFFER_HASH = '648de57d2cda114b736e5cfc89cbde12d1f84db57d5b2edfb6aa799ea3a5caf8';
const PREPARE_HASH = 'eda083b60670009f18292303697b403899f5da01a9ac5c1d52591cddb83b8f11';
export class HotelsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HotelsError';
  }
}

function cookieHeader() {
  let text = process.env.HOTELS_COOKIE?.trim() || '';
  if (text.toLowerCase().startsWith('cookie:')) text = text.slice(text.indexOf(':') + 1).trim();
  const pairs = new Map();
  for (const part of text.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) pairs.set(name, value);
  }
  if (!pairs.get('EG_SESSIONTOKEN')) throw new HotelsError('Hotels.com sign-in is missing.');
  if (pairs.has('EG_ANONTOKEN')) throw new HotelsError('Hotels.com sign-in is still anonymous.');
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

function context() {
  return {
    siteId: 300000001,
    locale: 'en_US',
    eapid: 1,
    tpid: 3001,
    currency: 'USD',
    device: { type: 'DESKTOP' },
    identity: {
      duaid: process.env.HOTELS_DUAID?.trim() || '58349ba0-30e4-4275-a3bf-118074746312',
      authState: 'AUTHENTICATED',
    },
    privacyTrackingState: 'CAN_TRACK',
  };
}

const http = new Impit({ browser: 'chrome151', timeout: 30000 });

async function request(method, url, { headers, body } = {}) {
  const response = await http.fetch(url, {
    method,
    headers: { accept: 'application/json', cookie: cookieHeader(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new HotelsError(`Hotels.com failed with HTTP ${response.status}`);
  return response.json();
}

export async function lookupCity(query) {
  const url = `https://www.hotels.com/api/v4/typeahead/${encodeURIComponent(query)}?siteid=300000001&locale=en_US&maxresults=5&features=ta_hierarchy&format=json`;
  const payload = await request('GET', url, { headers: { 'accept-language': 'en-US,en;q=0.6' } });
  const match = payload?.sr?.[0];
  if (!match) throw new HotelsError(`No Hotels.com city match for ${query}`);
  return {
    regionName: match.regionNames.fullName,
    regionId: String(match.gaiaId),
    coordinates: { latitude: Number(match.coordinates.lat), longitude: Number(match.coordinates.long) },
    pinnedPropertyId: null,
    propertyIds: null,
    mapBounds: null,
  };
}

function dateParts(value, name) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || date.toISOString().slice(0, 10) !== text) throw new HotelsError(`${name} must be YYYY-MM-DD`);
  return { iso: text, day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) };
}

function dateRange(checkIn, checkOut) {
  return {
    checkInDate: { day: checkIn.day, month: checkIn.month, year: checkIn.year },
    checkOutDate: { day: checkOut.day, month: checkOut.month, year: checkOut.year },
  };
}

function blank(value) {
  const text = String(value || '').trim();
  return ['', 'string', 'null', 'none'].includes(text.toLowerCase()) ? '' : text;
}

function stayFromCard(card) {
  const link = card?.cardLink?.resource?.value || '';
  const query = new URL(link || 'https://www.hotels.com/', 'https://www.hotels.com').searchParams;
  const propertyId = query.get('expediaPropertyId') || card?.id;
  if (!propertyId) return null;
  return {
    property_id: String(propertyId),
    name: card?.headingSection?.heading,
    price: card?.priceSection?.priceSummary?.options?.[0]?.displayPrice?.formatted,
    free_cancellation: freeCancellation(card),
    room_type_id: query.get('selectedRoomType'),
    rate_plan_id: query.get('selectedRatePlan'),
    search_id: query.get('searchId'),
    url: link,
  };
}

function freeCancellation(card) {
  const messages = card?.cardLink?.analytics?.uisPrimeMessages || [];
  for (const message of messages) {
    if (message?.schemaName !== 'allHotelProducts') continue;
    const content = typeof message.messageContent === 'string' ? JSON.parse(message.messageContent) : message.messageContent;
    const product = content?.hotelProducts?.[0];
    if (product) return Boolean(product.freeCancellation);
  }
  return false;
}

async function graphql(body, { operation, operationType, referer, pageId, clientInfo, extraHeaders }) {
  let payload = await request('POST', GRAPHQL, {
    headers: {
      accept: 'application/json, multipart/mixed',
      'accept-language': 'en-US,en;q=0.6',
      'content-type': 'application/json',
      'client-info': clientInfo,
      'ctx-view-id': crypto.randomUUID(),
      'x-apollo-operation-name': operation,
      'x-apollo-operation-type': operationType,
      'x-page-id': pageId,
      ...extraHeaders,
    },
    body,
  });
  if (Array.isArray(payload)) payload = payload[0];
  if (payload?.errors?.length) throw new HotelsError(`${operation} failed: ${payload.errors[0].message || 'GraphQL error'}`);
  return payload;
}

export async function searchStays(destination, checkIn, checkOut, adults, paymentType, lodging, propertyId) {
  const place = { ...destination };
  if (propertyId) {
    place.pinnedPropertyId = propertyId;
    place.propertyIds = [propertyId];
  }
  const searchId = crypto.randomUUID();
  const productOffersId = crypto.randomUUID();
  const selections = [
    { id: 'paymentType', value: paymentType },
    { id: 'privacyTrackingState', value: 'CAN_TRACK' },
    { id: 'productOffersId', value: productOffersId },
    { id: 'searchId', value: searchId },
    { id: 'sort', value: 'PRICE_LOW_TO_HIGH' },
    { id: 'useRewards', value: 'SHOP_WITHOUT_POINTS' },
  ];
  if (lodging) selections.push({ id: 'lodging', value: lodging }, { id: 'structureTypes', value: lodging });
  const payload = await graphql({
    operationName: 'PropertyListingQuery',
    variables: {
      context: context(),
      criteria: {
        primary: { dateRange: dateRange(checkIn, checkOut), destination: place, rooms: [{ adults, children: [] }] },
        secondary: {
          counts: [{ id: 'resultsStartingIndex', value: 0 }, { id: 'resultsSize', value: 8 }],
          booleans: [],
          selections,
          ranges: [],
        },
      },
      shoppingContext: { multiItem: null, queryTriggeredBy: 'FILTER_MODAL_APPLIED', typeaheadCollationId: null },
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: LISTING_HASH } },
  }, {
    operation: 'PropertyListingQuery',
    operationType: 'query',
    referer: `https://www.hotels.com/Hotel-Search?regionId=${place.regionId}&d1=${checkIn.iso}&d2=${checkOut.iso}&adults=${adults}&rooms=1&sort=PRICE_LOW_TO_HIGH&paymentType=${paymentType}`,
    pageId: 'page.Hotel-Search,H,20',
    clientInfo: 'shopping-pwa,00cd657c0a746cb3a71ac0b0370ed6edad9403f3,us-west-2',
    extraHeaders: { 'x-enable-apq': 'true', 'x-shopping-product-line': 'lodging' },
  });
  const search = payload?.data?.propertySearch;
  const stays = [];
  for (const card of search?.propertySearchListings || []) {
    if (card?.__typename !== 'LodgingCard') continue;
    const stay = stayFromCard(card);
    if (!stay) continue;
    stay.search_id = stay.search_id || searchId;
    stay.product_offers_id = productOffersId;
    stays.push(stay);
  }
  return { heading: search?.summary?.resultsHeading, stays };
}

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__typename').map(([key, item]) => [key, strip(item)]));
  }
  return value;
}

function amountFromPrice(formatted) {
  return Number((String(formatted || '').match(/\d/g) || []).join('') || '0');
}

async function openCheckout(destination, stay, checkIn, checkOut, adults, paymentType, lodging) {
  if (!stay.room_type_id || !stay.rate_plan_id) throw new HotelsError('The listing did not include a room and rate to open');
  const selections = [
    { id: 'paymentType', value: paymentType },
    { id: 'privacyTrackingState', value: 'CAN_TRACK' },
    { id: 'sort', value: 'PRICE_LOW_TO_HIGH' },
    { id: 'useRewards', value: 'SHOP_WITHOUT_POINTS' },
  ];
  if (stay.product_offers_id) selections.push({ id: 'productOffersId', value: stay.product_offers_id });
  if (stay.search_id) selections.push({ id: 'searchId', value: stay.search_id });
  if (lodging) selections.push({ id: 'lodging', value: lodging }, { id: 'structureTypes', value: lodging });
  const criteria = {
    primary: { dateRange: dateRange(checkIn, checkOut), destination, rooms: [{ adults, children: [] }] },
    secondary: { counts: [], booleans: [], selections, ranges: [] },
  };
  const offerPayload = await graphql([{
    operationName: 'SingleOfferQuery',
    variables: {
      skipRatePlans: false,
      propertyId: stay.property_id,
      searchCriteria: criteria,
      shoppingContext: { multiItem: null, queryTriggeredBy: 'OTHER' },
      travelAdTrackingInfo: null,
      searchOffer: {
        offerPrice: {
          offerTimestamp: String(Date.now()),
          price: { amount: amountFromPrice(stay.price), currency: 'USD' },
          pointsApplied: false,
        },
        roomTypeId: stay.room_type_id,
        ratePlanId: stay.rate_plan_id,
        offerDetails: [],
      },
      referrer: 'HSR',
      selectedSavedQuoteInput: null,
      productIdentifier: {
        id: stay.property_id,
        type: 'PROPERTY_ID',
        travelSearchCriteria: { property: criteria },
        shoppingContext: { multiItem: null, queryTriggeredBy: 'OTHER' },
      },
      context: context(),
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: OFFER_HASH } },
  }], {
    operation: 'SingleOfferQuery',
    operationType: 'query',
    referer: 'https://www.hotels.com/',
    pageId: 'page.Hotels.Infosite.Information,H,30',
    clientInfo: 'shopping-pwa,1406cb168a3ca179f09ab3ac5c5aaa78ec369173,us-west-2',
    extraHeaders: { 'x-hcom-origin-id': 'page.Hotels.Infosite.Information,H,30', 'x-shopping-product-line': 'lodging' },
  });
  const unit = offerPayload?.data?.propertyOffers?.singleUnitOffer;
  if (!unit) throw new HotelsError('The selected stay has no offer to open');
  const payLater = payLaterAction(unit);
  if (!payLater) throw new HotelsError('The selected stay has no pay-later rate');
  const prepared = await prepareCheckout(payLater.action);
  const checkout = prepared?.data?.prepareCheckout || prepared?.data?.lodgingPropertyCheckoutPrepareCheckout || {};
  return {
    property_id: stay.property_id,
    name: stay.name,
    price: stay.price,
    free_cancellation: stay.free_cancellation,
    payment_model: 'PAY_LATER',
    total: payLater.total,
    trip_id: checkout.tripId,
    checkout_url: checkout.checkoutUrl,
    failure_reason: checkout.failureReason,
  };
}

function payLaterAction(offer) {
  for (const plan of offer?.ratePlans || []) {
    for (const detail of plan?.priceDetails || []) {
      if (detail?.paymentModel !== 'PAY_LATER') continue;
      const action = detail?.lodgingPrepareCheckout?.action;
      if (!action) continue;
      const total = action.totalPrice || {};
      return { action, total: { amount: total.amount, currency: total.currency || total.currencyInfo?.code } };
    }
  }
  return null;
}

function prepareCheckout(action) {
  return graphql([{
    operationName: 'lodgingPropertyCheckoutPrepareCheckout',
    variables: {
      context: context(),
      properties: [strip(action.propertyNaturalKeys[0])],
      checkoutOptions: strip(action.checkoutOptions || []),
      offerTokens: strip(action.offerTokens || []),
      totalPrice: {
        amount: action.totalPrice?.amount,
        currency: action.totalPrice?.currency || action.totalPrice?.currencyInfo?.code,
      },
      responseOptions: ['ALTERNATIVE_ACTION_ON_FAILURE'],
    },
    extensions: { persistedQuery: { version: 1, sha256Hash: PREPARE_HASH } },
  }], {
    operation: 'lodgingPropertyCheckoutPrepareCheckout',
    operationType: 'mutation',
    referer: 'https://www.hotels.com/',
    pageId: 'page.Hotels.Infosite.Information,H,30',
    clientInfo: 'shopping-pwa,1406cb168a3ca179f09ab3ac5c5aaa78ec369173,us-west-2',
    extraHeaders: { 'x-hcom-origin-id': 'page.Hotels.Infosite.Information,H,30', 'x-shopping-product-line': 'lodging' },
  });
}

function publicStay(stay) {
  return {
    property_id: stay.property_id,
    name: stay.name,
    price: stay.price,
    free_cancellation: stay.free_cancellation,
    url: stay.url,
  };
}

export async function runHotelRequest(input) {
  const action = String(input?.action || 'search').trim().toLowerCase();
  if (!['search', 'checkout', 'bookable'].includes(action)) throw new HotelsError('action must be search, checkout, or bookable');
  const destinationName = String(input?.destination || '').trim();
  const checkIn = dateParts(input?.check_in, 'check_in');
  const checkOut = dateParts(input?.check_out, 'check_out');
  if (checkOut.iso <= checkIn.iso) throw new HotelsError('check_out must be after check_in');
  const adults = Number(input?.adults || 2);
  const paymentType = String(input?.payment_type || 'PAY_LATER').trim();
  const lodging = blank(input?.lodging);
  const wanted = blank(input?.property_id);
  const destination = await lookupCity(destinationName);
  const found = await searchStays(destination, checkIn, checkOut, adults, paymentType, lodging, action === 'checkout' ? wanted : '');
  const stays = found.stays.some((stay) => stay.free_cancellation) ? found.stays.filter((stay) => stay.free_cancellation) : found.stays;
  const result = {
    status: 'completed',
    action,
    destination: destination.regionName,
    check_in: checkIn.iso,
    check_out: checkOut.iso,
    payment_type: paymentType,
    lodging: lodging || null,
    heading: found.heading,
    stays: stays.map(publicStay),
  };
  if (action === 'search') return result;
  if (action === 'bookable') {
    const bookable = [];
    const skipped = [];
    for (const stay of stays) {
      try {
        const checkout = await openCheckout(destination, stay, checkIn, checkOut, adults, paymentType, lodging);
        if (!checkout.checkout_url) {
          skipped.push({ name: stay.name, price: stay.price, reason: checkout.failure_reason || 'The selected stay has no offer to open' });
          continue;
        }
        bookable.push({ ...publicStay(stay), checkout });
      } catch (error) {
        skipped.push({ name: stay.name, price: stay.price, reason: error instanceof HotelsError ? error.message : 'The selected stay has no offer to open' });
      }
    }
    return { ...result, bookable, skipped };
  }
  const candidates = wanted ? stays.filter((stay) => stay.property_id === wanted) : stays;
  if (wanted && !candidates.length) throw new HotelsError('No stay matched that property id');
  let lastError = new HotelsError('No stay matched that property id');
  for (const stay of candidates) {
    try {
      result.checkout = await openCheckout(destination, stay, checkIn, checkOut, adults, paymentType, lodging);
      return result;
    } catch (error) {
      lastError = error instanceof HotelsError ? error : lastError;
    }
  }
  result.checkout_error = lastError.message;
  return result;
}
