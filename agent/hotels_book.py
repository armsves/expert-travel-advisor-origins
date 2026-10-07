"""Finish a Hotels.com pay-later checkout on the card already saved in the session."""

from __future__ import annotations

import json
import os
import time
import uuid
from urllib.parse import urlparse

from agent.hotels_api import HotelsError, _cookie_header, _graphql, _impersonated, context

CHECKOUT_PAGE = "page.Hotels.Checkout.Payment,H,40"
CLIENT_INFO = "shopping-pwa,1406cb168a3ca179f09ab3ac5c5aaa78ec369173,us-west-2"
TRUST_SCRIPT = "https://www.expedia.com/trustProxy/tw.prod.hotels.rp.min.js"
THREEDS_SRC = "https://static.pay.expedia.com/3ds/threeDsIframe.html"
THREEDS_ORIGIN = "https://static.pay.expedia.com"


def confirm_reservation(checkout_url: str) -> dict:
    session_id = urlparse(checkout_url).path.rstrip("/").split("/")[-1]
    if not session_id:
        raise HotelsError("The checkout session is missing")
    if not (os.environ.get("HOTELS_CVV") or "").strip():
        raise HotelsError("The card security code is not configured")
    metadata, trust = _checkout_proof(session_id)
    session_token, card, access_token, token_uri = _payment_module(session_id, checkout_url)
    session_token = _submit_country(session_id, checkout_url, session_token)
    edge = _tokenize_stored_card(session_id, checkout_url, card, access_token, token_uri)
    session_id, session_token = _select_card(
        checkout_url, session_id, session_token, card, edge, metadata
    )
    return _book(checkout_url, session_id, session_token, trust)


def _checkout_call(operation: str, kind: str, query: str, variables: dict, checkout_url: str) -> dict:
    return _graphql(
        {"operationName": operation, "query": query, "variables": variables},
        operation=operation,
        operation_type=kind,
        referer=checkout_url,
        page_id=CHECKOUT_PAGE,
        client_info=CLIENT_INFO,
    )


def _payment_module(session_id: str, checkout_url: str):
    payload = _checkout_call(
        "PaymentModuleRenderQuery",
        "query",
        """
        query PaymentModuleRenderQuery($context: ContextInput, $sessionId: String, $clientId: String) {
          paymentModule(context: $context, sessionId: $sessionId, clientId: $clientId, templateConfig: {selectorStyle: "radio"}) {
            checkoutIdentifier { sessionId sessionToken }
            components {
              ... on PaymentCheckoutElement {
                fopModule {
                  ... on PaymentFOPSelector {
                    selectOptions {
                      instruments {
                        fopId
                        state
                        paymentMethod
                        paymentSubMethodUrn
                        isStoredCard
                        storedCardConfig { storedPaymentInstrumentId postalCode countryCode }
                      }
                    }
                  }
                }
              }
              ... on PaymentCardDetailsTokenizationField {
                accessTokenForCardTokenization
                cardTokenizationServiceURI
              }
            }
          }
        }
        """,
        {"context": context(), "sessionId": session_id, "clientId": "MCKO"},
        checkout_url,
    )
    module = (payload.get("data") or {}).get("paymentModule") or {}
    identifier = module.get("checkoutIdentifier") or {}
    session_token = identifier.get("sessionToken") or ""
    card = None
    access_token = ""
    token_uri = ""
    for component in module.get("components") or []:
        for fop in component.get("fopModule") or []:
            for option in fop.get("selectOptions") or []:
                for instrument in option.get("instruments") or []:
                    if instrument.get("isStoredCard") and card is None:
                        card = instrument
                    if instrument.get("isStoredCard") and instrument.get("state") == "STATE_SELECTED":
                        card = instrument
        if component.get("accessTokenForCardTokenization"):
            access_token = component["accessTokenForCardTokenization"]
            token_uri = component.get("cardTokenizationServiceURI") or ""
    if not card or not access_token or not token_uri or not session_token:
        raise HotelsError("Hotels.com did not offer the saved card for this checkout")
    return session_token, card, access_token, token_uri


def _submit_country(session_id: str, checkout_url: str, session_token: str) -> str:
    payload = _checkout_call(
        "SmartFormQuery",
        "query",
        """
        query SmartFormQuery($context: ContextInput!, $sessionId: String!, $type: SmartFormType, $checkoutUrl: String) {
          smartForm(context: $context, sessionId: $sessionId, type: $type, checkoutUrl: $checkoutUrl) {
            view {
              containers {
                elements {
                  ... on SmartFormSection {
                    elements {
                      __typename
                      ... on SmartFormFieldSet {
                        elements {
                          ... on SmartFormInput {
                            inputId
                            inputComponent {
                              ... on SmartFormSelectInputComponent { inputId options { value selected } }
                              ... on SmartFormPhoneNumberInputComponentV2 { countryCode { inputId options { value selected } } }
                            }
                          }
                          ... on SmartFormFieldRow {
                            components {
                              inputId
                              inputComponent {
                                ... on SmartFormSelectInputComponent { inputId options { value selected } }
                                ... on SmartFormPhoneNumberInputComponentV2 { countryCode { inputId options { value selected } } }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        """,
        {
            "context": context(),
            "sessionId": session_id,
            "type": "CONTACT_INFORMATION",
            "checkoutUrl": checkout_url,
        },
        checkout_url,
    )
    for item in _country_inputs(payload):
        updated = _checkout_call(
            "SmartFormMutation",
            "mutation",
            """
            mutation SmartFormMutation($context: ContextInput!, $sessionId: String!, $data: SmartFormDataInput!, $sessionToken: String!, $type: SmartFormType) {
              smartForm(context: $context, sessionId: $sessionId, sessionToken: $sessionToken, type: $type) {
                updateFormData(data: $data) { success sessionToken }
              }
            }
            """,
            {
                "context": context(),
                "sessionId": session_id,
                "sessionToken": session_token,
                "type": "CONTACT_INFORMATION",
                "data": {
                    "timestamp": str(int(time.time() * 1000)),
                    "userInput": {"userFieldInputs": [item]},
                },
            },
            checkout_url,
        )
        result = (((updated.get("data") or {}).get("smartForm") or {}).get("updateFormData") or {})
        if result.get("sessionToken"):
            session_token = result["sessionToken"]
        if result.get("success") is False:
            raise HotelsError("Hotels.com did not accept the traveler country code")
    return session_token


def _country_inputs(payload: dict) -> list[dict]:
    view = (((payload.get("data") or {}).get("smartForm") or {}).get("view") or {})
    found = []
    for container in view.get("containers") or []:
        for section in container.get("elements") or []:
            for element in section.get("elements") or []:
                for child in element.get("elements") or []:
                    targets = []
                    component = child.get("inputComponent") or {}
                    if component.get("options"):
                        targets.append((child.get("inputId"), component))
                    if component.get("countryCode"):
                        targets.append((component["countryCode"].get("inputId"), component["countryCode"]))
                    for row in child.get("components") or []:
                        inner = row.get("inputComponent") or {}
                        if inner.get("options"):
                            targets.append((row.get("inputId"), inner))
                        if inner.get("countryCode"):
                            targets.append((inner["countryCode"].get("inputId"), inner["countryCode"]))
                    for input_id, target in targets:
                        if "country" not in (input_id or ""):
                            continue
                        selected = [opt for opt in (target.get("options") or []) if opt.get("selected")]
                        if selected and selected[0].get("value"):
                            found.append({"inputId": input_id, "value": [selected[0]["value"]]})
    return found


def _tokenize_stored_card(session_id, checkout_url, card, access_token, token_uri) -> str:
    created = _checkout_call(
        "CreatePaymentToken",
        "mutation",
        """
        mutation CreatePaymentToken($context: ContextInput!, $paymentTokenRequest: PaymentTokenRequestInput!, $clientId: String) {
          createPaymentTokenization(context: $context, paymentTokenRequest: $paymentTokenRequest, clientId: $clientId) {
            storedInstrumentToken
          }
        }
        """,
        {
            "context": context(),
            "clientId": "LEGACY_CPM",
            "paymentTokenRequest": {
                "storedPaymentInstrumentId": card["storedCardConfig"]["storedPaymentInstrumentId"],
                "sessionId": session_id,
            },
        },
        checkout_url,
    )
    instrument_token = (
        ((created.get("data") or {}).get("createPaymentTokenization") or {}).get("storedInstrumentToken")
        or ""
    )
    if not instrument_token:
        raise HotelsError("Hotels.com did not tokenize the saved card")
    status, raw = _impersonated(
        "POST",
        token_uri,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": "Bearer " + access_token,
            "referer": checkout_url,
        },
        json_body={
            "instrument_token": instrument_token,
            "customer_address_postal_code": card["storedCardConfig"].get("postalCode") or "",
            "customer_address_country_code": card["storedCardConfig"].get("countryCode") or "USA",
            "payment_instrument_type": "STORED_BANK_INSTRUMENT",
            "card_verification_value": os.environ["HOTELS_CVV"].strip(),
        },
    )
    try:
        edge = (json.loads(raw) or {}).get("id") or ""
    except json.JSONDecodeError:
        edge = ""
    if status != 200 or not edge:
        raise HotelsError("Hotels.com did not accept the saved card")
    return edge


def _select_card(checkout_url, session_id, session_token, card, edge, metadata):
    payload = _checkout_call(
        "UpdatePaymentMethodMutation",
        "mutation",
        """
        mutation UpdatePaymentMethodMutation($updatePaymentMethodRequest: UpdatePaymentMethodMutationRequestInput!, $context: ContextInput, $clientId: String) {
          updatePaymentMethod(updatePaymentMethodRequest: $updatePaymentMethodRequest, context: $context, clientId: $clientId) {
            updatedFops { state }
            checkoutIdentifier { sessionId sessionToken }
          }
        }
        """,
        {
            "context": context(),
            "clientId": "LEGACY_CPM",
            "updatePaymentMethodRequest": {
                "checkoutIdentifier": {"sessionId": session_id, "sessionToken": session_token},
                "fopItems": [
                    {
                        "id": card["fopId"],
                        "state": "STATE_SELECTED",
                        "paymentMethod": card.get("paymentMethod") or "CREDIT_CARD",
                        "paymentMethodConfiguration": {
                            "etzToken": edge,
                            "encodedBrowserMetadata": metadata,
                            "subMethodUrn": card.get("paymentSubMethodUrn") or "",
                            "storedCardInstrument": {"id": card["storedCardConfig"]["storedPaymentInstrumentId"]},
                        },
                    }
                ],
            },
        },
        checkout_url,
    )
    updated = (payload.get("data") or {}).get("updatePaymentMethod") or {}
    identifier = updated.get("checkoutIdentifier") or {}
    return identifier.get("sessionId") or session_id, identifier.get("sessionToken") or session_token


def _book(checkout_url, session_id, session_token, trust) -> dict:
    status, raw = _impersonated(
        "POST",
        "https://www.hotels.com/graphql",
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "client-info": CLIENT_INFO,
            "x-apollo-operation-name": "BookMutation",
            "x-apollo-operation-type": "mutation",
            "x-page-id": CHECKOUT_PAGE,
            "referer": checkout_url,
            "cookie": _cookie_header(),
        },
        json_body={
            "operationName": "BookMutation",
            "query": """
            mutation BookMutation($checkoutSessionInfo: CheckoutSessionInfoInput!, $context: ContextInput!, $domainInfoList: [CheckoutDomainInfoInput!], $checkoutSessionMode: CheckoutSessionMode, $clientId: String) {
              book(checkoutSessionInfo: $checkoutSessionInfo, context: $context, domainInfoList: $domainInfoList, checkoutSessionMode: $checkoutSessionMode, clientId: $clientId) {
                data {
                  orderId
                  orderNumber
                  itineraryNumber
                  signals { signal }
                  serverSignals { payload { signalDetails { reasonUrn summary description } } }
                  feedbackMessage { text }
                }
              }
            }
            """,
            "variables": {
                "context": context(),
                "clientId": "MCKO",
                "checkoutSessionMode": "CHECKOUT_SESSION_MODE_REGULAR",
                "domainInfoList": [{"name": "trustServicePayload", "refId": trust}],
                "checkoutSessionInfo": {"sessionId": session_id, "sessionToken": session_token},
            },
        },
    )
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HotelsError("Hotels.com did not return a reservation") from exc
    if isinstance(payload, list):
        payload = payload[0]
    data = ((payload.get("data") or {}).get("book") or {}).get("data") or {}
    order_id = data.get("orderId") or ""
    itinerary = data.get("itineraryNumber") or ""
    order_number = data.get("orderNumber") or ""
    if status != 200 or not (order_id or itinerary or order_number):
        raise HotelsError(_book_failure(payload, data))
    return {
        "order_id": order_id,
        "order_number": order_number,
        "itinerary_number": itinerary,
        "signals": [item.get("signal") for item in (data.get("signals") or []) if item.get("signal")],
    }


def _book_failure(payload: dict, data: dict) -> str:
    parts = []
    for signal in data.get("serverSignals") or []:
        for detail in ((signal.get("payload") or {}).get("signalDetails") or []):
            text = detail.get("summary") or detail.get("description") or detail.get("reasonUrn") or ""
            if text and "@" not in text:
                parts.append(text)
    if not parts:
        errors = payload.get("errors") or []
        if errors:
            parts.append(errors[0].get("message") or "Hotels.com did not make the reservation")
    return (parts[0] if parts else "Hotels.com did not make the reservation")[:240]


def _checkout_proof(session_id: str) -> tuple[str, str]:
    from playwright.sync_api import sync_playwright

    message_id = str(uuid.uuid4())
    chrome = "/usr/bin/google-chrome"
    launch = {"headless": True, "args": ["--disable-http2", "--disable-quic"]}
    if os.path.exists(chrome):
        launch["executable_path"] = chrome
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page()
        page.goto("https://www.expedia.com/", wait_until="domcontentloaded", timeout=20000)
        metadata = page.evaluate(
            """
            async ({src, origin, referenceId, messageId}) => {
              const frame = document.createElement("iframe");
              frame.src = src;
              frame.style.display = "none";
              document.body.appendChild(frame);
              await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("iframe timeout")), 15000);
                const onMessage = (event) => {
                  if (event.origin !== origin) return;
                  const data = event.data || {};
                  if (data.messageType === "frameReadyCheck" && data.messageStep === "response") {
                    clearTimeout(timer);
                    window.removeEventListener("message", onMessage);
                    resolve(true);
                  }
                };
                window.addEventListener("message", onMessage);
                const ping = () => {
                  if (frame.contentWindow) {
                    frame.contentWindow.postMessage({
                      messageType: "frameReadyCheck",
                      messageStep: "request",
                      messageData: null,
                      messageId,
                      messageSenderVersion: "2.0.13"
                    }, origin);
                  }
                };
                const interval = setInterval(ping, 200);
                setTimeout(() => clearInterval(interval), 15000);
              });
              return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("setup timeout")), 15000);
                const onMessage = (event) => {
                  if (event.origin !== origin) return;
                  const data = event.data || {};
                  if (data.messageType === "setup" && data.messageStep === "response" && data.messageId === messageId) {
                    clearTimeout(timer);
                    window.removeEventListener("message", onMessage);
                    resolve((data.messageData || {}).encodedBrowserMetadata || "");
                  }
                };
                window.addEventListener("message", onMessage);
                frame.contentWindow.postMessage({
                  messageType: "setup",
                  messageStep: "request",
                  messageData: {referenceId},
                  messageId,
                  messageSenderVersion: "2.0.13"
                }, origin);
              });
            }
            """,
            {
                "src": THREEDS_SRC,
                "origin": THREEDS_ORIGIN,
                "referenceId": session_id,
                "messageId": message_id,
            },
        )
        page.evaluate(
            """sid => {
              window.getCheckoutSessionIdFromJs = () => sid;
              window.trustApi = {clientConfiguration: {
                webSessionProviderMethod: "JS",
                webSessionProviderMethodParam: "return window.getCheckoutSessionIdFromJs()",
                placement: "PURCHASE",
                reportingSegment: "300000001,www.hotels.com,Hotels.com,CKO"
              }};
            }""",
            session_id,
        )
        page.add_script_tag(url=TRUST_SCRIPT)
        page.wait_for_timeout(4000)
        trust = page.evaluate(
            "() => window.trustApi && window.trustApi.getTrustPayload ? window.trustApi.getTrustPayload() : ''"
        )
        browser.close()
    if not metadata:
        raise HotelsError("Hotels.com did not return the browser check")
    if not trust:
        raise HotelsError("Hotels.com did not return the checkout trust payload")
    return metadata, trust
