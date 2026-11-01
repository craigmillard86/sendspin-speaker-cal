"""Speaker Tuner's data in Home Assistant: speakers, profiles, measurements, tuning results.

The app keeps a handful of JSON documents under named keys ("mappings", "profiles",
"measurements", "tuning" ...). Each key is its own file in .storage, so saving the large
measurement list never rewrites the small ones, and an index file lists the keys.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

STORAGE_VERSION = 1
KEY_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,79}$")
MAX_KEYS = 200
MAX_BYTES = 3 * 1024 * 1024  # one key; under HA's 4 MB WebSocket message limit
SAVE_DELAY = 1.0


class TunerStore:
    """Named JSON documents, each persisted to its own Store, loaded once."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._index: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, f"{DOMAIN}.index")
        self._stores: dict[str, Store[dict[str, Any]]] = {}
        self.values: dict[str, Any] = {}
        self.updated: dict[str, str] = {}

    def _store(self, key: str) -> Store[dict[str, Any]]:
        if key not in self._stores:
            self._stores[key] = Store(self._hass, STORAGE_VERSION, f"{DOMAIN}.data.{key}")
        return self._stores[key]

    async def async_load(self) -> None:
        """Load the index and every key it lists."""
        index = await self._index.async_load() or {}
        self.updated = dict(index.get("updated", {}))
        for key in list(self.updated):
            data = await self._store(key).async_load()
            if data is None:
                self.updated.pop(key, None)
                continue
            self.values[key] = data.get("value")

    def set(self, key: str, value: Any) -> str:
        """Set (or, with None, remove) one key; returns its new timestamp. Raises ValueError."""
        if not KEY_RE.match(key):
            raise ValueError(f"Invalid key {key!r}")
        now = datetime.now(UTC).isoformat()
        if value is None:
            self.values.pop(key, None)
            self.updated.pop(key, None)
            self._hass.async_create_task(self._store(key).async_remove())
        else:
            size = len(json.dumps(value, separators=(",", ":")))
            if size > MAX_BYTES:
                raise ValueError(f"{key} is {size // 1024} KB; the limit is {MAX_BYTES // 1024} KB")
            if key not in self.values and len(self.values) >= MAX_KEYS:
                raise ValueError(f"No more than {MAX_KEYS} keys")
            self.values[key] = value
            self.updated[key] = now
            self._store(key).async_delay_save(lambda: {"value": self.values.get(key)}, SAVE_DELAY)
        self._index.async_delay_save(lambda: {"updated": dict(self.updated)}, SAVE_DELAY)
        return now

    async def async_remove_all(self) -> None:
        """Delete every file (the integration is being removed)."""
        for key in list(self.updated):
            await self._store(key).async_remove()
        await self._index.async_remove()
        self.values.clear()
        self.updated.clear()
