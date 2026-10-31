"""The test noise upload, as the app sends it, against Home Assistant's real upload endpoint.

Mirrors uploadMedia() and MEDIA_FOLDER in frontend/src/ha/connection.js.
"""

from pathlib import Path

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

MEDIA_FOLDER = "media-source://media_source/local/speaker-tuner"


async def test_upload_creates_folder_and_returns_playable_id(hass: HomeAssistant, hass_client, tmp_path: Path) -> None:
    """HA creates the speaker-tuner folder and returns <folder>/<file name>."""
    hass.config.media_dirs = {"local": str(tmp_path)}
    assert await async_setup_component(hass, "http", {})
    assert await async_setup_component(hass, "media_source", {})
    client = await hass_client()

    form = aiohttp.FormData()
    form.add_field("media_content_id", MEDIA_FOLDER)
    form.add_field("file", b"RIFF....WAVE", filename="speaker-tuner-pink-20s.wav", content_type="audio/wav")
    res = await client.post("/api/media_source/local_source/upload", data=form)

    assert res.status == 200
    body = await res.json()
    assert body["media_content_id"] == f"{MEDIA_FOLDER}/speaker-tuner-pink-20s.wav"
    assert (tmp_path / "speaker-tuner" / "speaker-tuner-pink-20s.wav").read_bytes() == b"RIFF....WAVE"
