"""WebSocket commands the app uses to keep its data in Home Assistant. Admins only."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, EVENT_UPDATED

DATA_STORE = f"{DOMAIN}_store"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the commands (once per Home Assistant run)."""
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_set)


def _store(hass: HomeAssistant):
    return hass.data.get(DATA_STORE)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/store/get",
        vol.Optional("keys"): [str],
    }
)
@websocket_api.require_admin
@callback
def ws_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The keys asked for, with when each was last saved. Without "keys": only the index
    (every key and its timestamp), so the client can fetch the keys one by one and no reply
    comes near the WebSocket message limit."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Speaker Tuner is not set up")
        return
    if "keys" not in msg:
        connection.send_result(msg["id"], {"values": {}, "updated": dict(store.updated)})
        return
    keys = msg["keys"]
    connection.send_result(
        msg["id"],
        {
            "values": {k: store.values[k] for k in keys if k in store.values},
            "updated": {k: store.updated[k] for k in keys if k in store.updated},
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/store/set",
        vol.Required("key"): str,
        vol.Required("value"): vol.Any(dict, list, str, int, float, bool, None),
        vol.Optional("client"): str,
    }
)
@websocket_api.require_admin
@callback
def ws_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Save one key (None removes it) and tell every open panel."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Speaker Tuner is not set up")
        return
    try:
        updated = store.set(msg["key"], msg["value"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    hass.bus.async_fire(EVENT_UPDATED, {"key": msg["key"], "client": msg.get("client"), "updated": updated})
    connection.send_result(msg["id"], {"updated": updated})
