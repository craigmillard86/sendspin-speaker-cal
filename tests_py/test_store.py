"""Speaker Tuner: data kept in Home Assistant through the WebSocket commands."""

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import async_fire_time_changed
from homeassistant.util import dt as dt_util
from datetime import timedelta

from custom_components.speaker_tuner.const import DOMAIN, EVENT_UPDATED


async def _setup(hass: HomeAssistant):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    await hass.async_block_till_done()
    return result["result"]


async def test_set_get_and_event(hass: HomeAssistant, hass_ws_client) -> None:
    """A saved key comes back, with its timestamp, and every panel hears about it."""
    await _setup(hass)
    events = []
    hass.bus.async_listen(EVENT_UPDATED, lambda e: events.append(e.data))
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "speaker_tuner/store/set", "key": "mappings", "value": [{"id": "m1", "name": "Left"}], "client": "c1"})
    res = await ws.receive_json()
    assert res["success"], res
    await ws.send_json({"id": 2, "type": "speaker_tuner/store/get"})
    res = await ws.receive_json()
    assert res["result"]["values"] == {}, "without keys: the index only"
    assert "mappings" in res["result"]["updated"]
    await ws.send_json({"id": 3, "type": "speaker_tuner/store/get", "keys": ["mappings", "nope"]})
    res = await ws.receive_json()
    assert res["result"]["values"] == {"mappings": [{"id": "m1", "name": "Left"}]}
    await hass.async_block_till_done()
    assert events and events[0]["key"] == "mappings" and events[0]["client"] == "c1"


async def test_data_survives_a_reload(hass: HomeAssistant, hass_ws_client, hass_storage) -> None:
    """Values are written to .storage and loaded again after the entry reloads."""
    entry = await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "speaker_tuner/store/set", "key": "profiles", "value": [{"id": "p"}]})
    assert (await ws.receive_json())["success"]
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=5))
    await hass.async_block_till_done()
    assert hass_storage["speaker_tuner.data.profiles"]["data"] == {"value": [{"id": "p"}]}
    assert "profiles" in hass_storage["speaker_tuner.index"]["data"]["updated"]
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    ws2 = await hass_ws_client(hass)
    await ws2.send_json({"id": 1, "type": "speaker_tuner/store/get", "keys": ["profiles"]})
    assert (await ws2.receive_json())["result"]["values"] == {"profiles": [{"id": "p"}]}


async def test_remove_and_limits(hass: HomeAssistant, hass_ws_client) -> None:
    """None removes a key; bad keys and oversized values are refused."""
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "speaker_tuner/store/set", "key": "cal", "value": {"freqs": [1], "db": [0]}})
    assert (await ws.receive_json())["success"]
    await ws.send_json({"id": 2, "type": "speaker_tuner/store/set", "key": "cal", "value": None})
    assert (await ws.receive_json())["success"]
    await ws.send_json({"id": 3, "type": "speaker_tuner/store/get"})
    assert (await ws.receive_json())["result"]["updated"] == {}
    await ws.send_json({"id": 4, "type": "speaker_tuner/store/set", "key": "../etc", "value": 1})
    res = await ws.receive_json()
    assert not res["success"] and res["error"]["code"] == "invalid"
    await ws.send_json({"id": 5, "type": "speaker_tuner/store/set", "key": "big", "value": "x" * (3 * 1024 * 1024 + 100)})
    res = await ws.receive_json()
    assert not res["success"] and "limit" in res["error"]["message"]


async def test_admin_only(hass: HomeAssistant, hass_ws_client, hass_read_only_access_token) -> None:
    """A non-admin user can neither read nor write."""
    await _setup(hass)
    ws = await hass_ws_client(hass, hass_read_only_access_token)
    await ws.send_json({"id": 1, "type": "speaker_tuner/store/get"})
    res = await ws.receive_json()
    assert not res["success"] and res["error"]["code"] == "unauthorized"


async def test_removing_the_integration_deletes_its_data(hass: HomeAssistant, hass_ws_client, hass_storage) -> None:
    """Deleting the integration removes every stored file."""
    entry = await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "speaker_tuner/store/set", "key": "mappings", "value": []})
    assert (await ws.receive_json())["success"]
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=5))
    await hass.async_block_till_done()
    assert "speaker_tuner.data.mappings" in hass_storage
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert "speaker_tuner.data.mappings" not in hass_storage
    assert "speaker_tuner.index" not in hass_storage
