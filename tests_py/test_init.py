"""Speaker Tuner: config flow, panel registration and static files."""

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.setup import async_setup_component

from custom_components.speaker_tuner.const import DOMAIN, PANEL_URL_PATH, STATIC_URL


async def _add_entry(hass: HomeAssistant):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    return result["result"]


async def test_config_flow_creates_one_entry(hass: HomeAssistant) -> None:
    """Adding the integration creates an entry; a second one is refused."""
    entry = await _add_entry(hass)
    assert entry.title == "Speaker Tuner"
    again = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert again["type"] is FlowResultType.ABORT
    assert again["reason"] == "single_instance_allowed"


async def test_panel_registered_for_admins(hass: HomeAssistant) -> None:
    """The sidebar panel loads panel.js as a module and needs an admin."""
    await _add_entry(hass)
    panels = hass.data["frontend_panels"]
    assert PANEL_URL_PATH in panels
    panel = panels[PANEL_URL_PATH]
    assert panel.require_admin is True
    assert panel.sidebar_title == "Speaker Tuner"
    custom = panel.config["_panel_custom"]
    assert custom["name"] == "speaker-tuner-panel"
    assert custom["module_url"].startswith(f"{STATIC_URL}/panel.js?v=")
    assert custom["embed_iframe"] is False


async def test_app_files_are_served(hass: HomeAssistant, hass_client) -> None:
    """The panel, its modules, styles and profiles are reachable over HTTP."""
    assert await async_setup_component(hass, "http", {})
    await _add_entry(hass)
    client = await hass_client()
    for path in (
        "panel.js",
        "app.css",
        "src/ui/app.js",
        "src/dsp/fit.js",
        "profiles/louder-tas5805m-crossover.json",
        "mics/akg-ck32.json",
        "targets/flat.json",
    ):
        res = await client.get(f"{STATIC_URL}/{path}")
        assert res.status == 200, path
    missing = await client.get(f"{STATIC_URL}/nope.js")
    assert missing.status == 404


async def test_unload_and_reload(hass: HomeAssistant) -> None:
    """Unloading removes the panel; loading again brings it back without errors."""
    entry = await _add_entry(hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data["frontend_panels"]
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH in hass.data["frontend_panels"]
