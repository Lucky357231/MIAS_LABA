from fastapi import FastAPI, Query, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from typing import Dict, Any, List, Optional, Tuple
import requests, time, csv, io as iolib
from datetime import datetime, timezone

"""
LR2-style web app (FastAPI + Jinja2 + HTML/CSS/JS) for CoinGecko WITHOUT API key.

UI provides:
- table of top coins (markets),
- filter,
- converter,
- price history chart for a period.

API provides:
GET  /cg/top
GET  /cg/price
GET  /cg/convert
GET  /cg/top.csv
GET  /cg/history

Run:
  pip install -r requirements.txt
  uvicorn main:app --reload --port 8061
Open:
  UI:   http://127.0.0.1:8061/
  Docs: http://127.0.0.1:8061/docs
"""

COINGECKO_BASE = "https://api.coingecko.com/api/v3"

app = FastAPI(title="CoinGecko Web", openapi_url="/openapi.json")

app.mount("/static", StaticFiles(directory="static", check_dir=False), name="static")
templates = Jinja2Templates(directory="templates")

# Cache: (key) -> (timestamp, data)
_cache: Dict[Tuple[str, str], Tuple[float, Any]] = {}
TTL_SECONDS = 30


def _cache_get(key: Tuple[str, str]) -> Optional[Any]:
    now = time.time()
    if key in _cache:
        ts, data = _cache[key]
        if now - ts < TTL_SECONDS:
            return data
    return None


def _cache_set(key: Tuple[str, str], data: Any) -> None:
    _cache[key] = (time.time(), data)


def fetch_top(vs: str, per_page: int, page: int) -> Dict[str, Any]:
    vs = (vs or "usd").lower()
    per_page = max(1, min(int(per_page), 250))
    page = max(1, int(page))

    ck = ("top", f"{vs}:{per_page}:{page}")
    cached = _cache_get(ck)
    if cached is not None:
        return {"cached": True, **cached}

    params = {
        "vs_currency": vs,
        "order": "market_cap_desc",
        "per_page": per_page,
        "page": page,
        "sparkline": "false",
        "price_change_percentage": "24h",
    }

    try:
        r = requests.get(f"{COINGECKO_BASE}/coins/markets", params=params, timeout=20)
    except Exception as e:
        return {"error": f"Network error: {e}"}

    if r.status_code != 200:
        return {"error": f"CoinGecko returned {r.status_code}", "details": r.text[:300]}

    if "json" not in (r.headers.get("content-type") or "").lower():
        return {"error": "Not a JSON response from CoinGecko", "details": r.text[:300]}

    rows = r.json()
    items: List[Dict[str, Any]] = []
    for x in rows:
        items.append(
            {
                "market_cap_rank": x.get("market_cap_rank"),
                "id": x.get("id"),
                "symbol": x.get("symbol"),
                "name": x.get("name"),
                "current_price": x.get("current_price"),
                "market_cap": x.get("market_cap"),
                "price_change_percentage_24h": x.get("price_change_percentage_24h"),
            }
        )

    out = {"vs": vs, "page": page, "per_page": per_page, "count": len(items), "items": items}
    _cache_set(ck, out)
    return out


def fetch_price(coin_id: str, vs: str, include_24h_change: bool = False) -> Dict[str, Any]:
    coin_id = (coin_id or "").strip().lower()
    vs = (vs or "usd").strip().lower()
    if not coin_id:
        return {"error": "coin_id is required"}

    ck = ("price", f"{coin_id}:{vs}:{int(include_24h_change)}")
    cached = _cache_get(ck)
    if cached is not None:
        return {"cached": True, **cached}

    params = {
        "ids": coin_id,
        "vs_currencies": vs,
        "include_last_updated_at": "true",
        "include_24hr_change": "true" if include_24h_change else "false",
    }

    try:
        r = requests.get(f"{COINGECKO_BASE}/simple/price", params=params, timeout=20)
    except Exception as e:
        return {"error": f"Network error: {e}"}

    if r.status_code != 200:
        return {"error": f"CoinGecko returned {r.status_code}", "details": r.text[:300]}

    if "json" not in (r.headers.get("content-type") or "").lower():
        return {"error": "Not a JSON response from CoinGecko", "details": r.text[:300]}

    data = r.json()
    if coin_id not in data or vs not in data[coin_id]:
        return {"error": "No price found (check coin_id and vs currency)", "coin_id": coin_id, "vs": vs}

    out = {
        "coin_id": coin_id,
        "vs": vs,
        "price": data[coin_id][vs],
        "last_updated_at": data[coin_id].get("last_updated_at"),
    }
    if include_24h_change:
        out["change_24h"] = data[coin_id].get(f"{vs}_24h_change")

    _cache_set(ck, out)
    return out


def _parse_iso_date(date_iso: str) -> datetime:
    # expects YYYY-MM-DD
    return datetime.strptime(date_iso, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def fetch_history_range(coin_id: str, vs: str, date_from: str, date_to: str) -> Dict[str, Any]:
    coin_id = (coin_id or "").strip().lower()
    vs = (vs or "usd").strip().lower()
    if not coin_id:
        return {"error": "coin_id is required"}
    if not date_from or not date_to:
        return {"error": "date_from and date_to are required (YYYY-MM-DD)"}

    try:
        dt_from = _parse_iso_date(date_from)
        dt_to = _parse_iso_date(date_to)
    except Exception:
        return {"error": "bad dates (use YYYY-MM-DD)"}

    if dt_to < dt_from:
        dt_from, dt_to = dt_to, dt_from

    # CoinGecko range endpoint expects unix seconds
    unix_from = int(dt_from.timestamp())
    # include whole 'to' day
    unix_to = int((dt_to + datetime.resolution).timestamp()) + 24 * 3600 - 1

    ck = ("hist", f"{coin_id}:{vs}:{unix_from}:{unix_to}")
    cached = _cache_get(ck)
    if cached is not None:
        return {"cached": True, **cached}

    params = {"vs_currency": vs, "from": unix_from, "to": unix_to}
    try:
        r = requests.get(f"{COINGECKO_BASE}/coins/{coin_id}/market_chart/range", params=params, timeout=20)
    except Exception as e:
        return {"error": f"Network error: {e}"}

    if r.status_code != 200:
        return {"error": f"CoinGecko returned {r.status_code}", "details": r.text[:300]}

    if "json" not in (r.headers.get("content-type") or "").lower():
        return {"error": "Not a JSON response from CoinGecko", "details": r.text[:300]}

    raw = r.json()
    prices = raw.get("prices") or []  # [[ms, price], ...]
    points: List[Dict[str, Any]] = []
    for ms, price in prices:
        try:
            dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date()
            points.append({"date": dt.isoformat(), "price": float(price)})
        except Exception:
            continue

    # de-duplicate by date (keep last of day)
    by_day: Dict[str, float] = {}
    for p in points:
        by_day[p["date"]] = p["price"]
    points2 = [{"date": d, "price": by_day[d]} for d in sorted(by_day.keys())]

    out = {"coin_id": coin_id, "vs": vs, "from": date_from, "to": date_to, "points": points2, "count": len(points2)}
    _cache_set(ck, out)
    return out


# ===== API =====

@app.get("/cg/top")
def cg_top(vs: str = Query("usd"), per_page: int = Query(50, ge=1, le=250), page: int = Query(1, ge=1)):
    return fetch_top(vs, per_page, page)


@app.get("/cg/price")
def cg_price(
    coin_id: str = Query(..., description="CoinGecko coin id, e.g. bitcoin"),
    vs: str = Query("usd"),
    include_24h_change: bool = Query(False),
):
    return fetch_price(coin_id, vs, include_24h_change)


@app.get("/cg/convert")
def cg_convert(
    coin_id: str = Query(..., description="CoinGecko coin id, e.g. bitcoin"),
    vs: str = Query("usd", description="Target currency"),
    amount: float = Query(1.0, description="How many coins to convert"),
):
    price = fetch_price(coin_id, vs, include_24h_change=False)
    if "error" in price:
        return price
    rate = float(price["price"])
    return {
        "coin_id": coin_id,
        "amount": amount,
        "vs": vs,
        "rate": rate,
        "result": amount * rate,
        "last_updated_at": price.get("last_updated_at"),
        "cached": price.get("cached", False),
    }


@app.get("/cg/history")
def cg_history(
    coin_id: str = Query(..., description="CoinGecko coin id, e.g. bitcoin"),
    vs: str = Query("usd"),
    date_from: str = Query(..., description="YYYY-MM-DD"),
    date_to: str = Query(..., description="YYYY-MM-DD"),
):
    return fetch_history_range(coin_id, vs, date_from, date_to)


@app.get("/cg/top.csv")
def cg_top_csv(vs: str = Query("usd"), per_page: int = Query(100, ge=1, le=250), page: int = Query(1, ge=1)):
    data = fetch_top(vs, per_page, page)
    if "error" in data:
        return data

    out = iolib.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["rank", "id", "symbol", "name", "price", "market_cap", "change_24h_pct"])
    for it in data.get("items", []):
        w.writerow(
            [
                it.get("market_cap_rank"),
                it.get("id"),
                (it.get("symbol") or "").upper(),
                it.get("name"),
                it.get("current_price"),
                it.get("market_cap"),
                it.get("price_change_percentage_24h"),
            ]
        )

    csv_bytes = out.getvalue().encode("utf-8-sig")
    fn = f'cg_top_{data.get("vs","usd")}_p{data.get("page",1)}_{data.get("per_page",0)}.csv'
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fn}"'},
    )


# ===== UI =====

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # Provide a short datalist for coin ids (top 250)
    data = fetch_top("usd", 250, 1)
    coin_ids = []
    if isinstance(data, dict) and "items" in data:
        coin_ids = [x.get("id") for x in data["items"] if x.get("id")]
    return templates.TemplateResponse("index.html", {"request": request, "coin_ids": coin_ids})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8061, log_level="info")
