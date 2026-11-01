"""Speaker Tuner: a sidebar panel that measures and tunes ESPHome speakers.

The integration serves the web app, adds the panel, and keeps the app's data (speakers,
profiles, measurements, tuning results) in Home Assistant's storage, reached through two
admin-only WebSocket commands. Measuring and tuning happen in the browser through Home
Assistant's normal APIs, the same way the standalone page works.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL_PATH, STATIC_URL, WEB_COMPONENT
from .storage import TunerStore
from .websocket_api import DATA_STORE, async_register

FRONTEND_DIR = Path(__file__).parent / "frontend"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Serve the app and add the sidebar panel."""
    integration = await async_get_integration(hass, DOMAIN)
    # The app is a tree of ES modules that import each other by relative URL. Serving it under
    # a path that includes the version gives every file a new URL after an update, so a
    # browser can never mix cached modules from the old version with the new ones.
    base = f"{STATIC_URL}/{integration.version}"
    # static paths cannot be removed again, so register them once per HA run
    if hass.data.get(DOMAIN) != base:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(base, str(FRONTEND_DIR), cache_headers=False)]
        )
        hass.data[DOMAIN] = base
    # the commands, like the static path, stay registered for the whole run
    if not hass.data.get(f"{DOMAIN}_ws"):
        async_register(hass)
        hass.data[f"{DOMAIN}_ws"] = True
    store = TunerStore(hass)
    await store.async_load()
    hass.data[DATA_STORE] = store

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=WEB_COMPONENT,
        frontend_url_path=PANEL_URL_PATH,
        module_url=f"{base}/panel.js",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=True,
        embed_iframe=False,
        config={},
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the sidebar panel; the data stays on disk for the next setup."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    hass.data.pop(DATA_STORE, None)
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """The integration is being deleted: delete its data too."""
    store = TunerStore(hass)
    await store.async_load()
    await store.async_remove_all()
