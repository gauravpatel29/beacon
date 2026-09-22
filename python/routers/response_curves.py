import json
from fastapi import APIRouter, HTTPException
from core.processing import create_response_curve
import numpy as np

router = APIRouter()


@router.post("/generate")
async def generate_response_curves(payload: dict):
    """
    Generate response curves for each channel.
    payload: {
        channels: [{
            name, impactable_sales_nation, beta_coeff, spend_nation,
            start, stop, step, price, saturation_function, power_value
        }],
        num_time, num_geo
    }
    """
    try:
        results = {}
        num_time = payload.get("num_time", 12)
        num_geo = payload.get("num_geo", 2614)
        
        for ch in payload.get("channels", []):
            channel_name = ch["name"]
            impactable_sales = float(ch.get("impactable_sales_nation", 0.0))
            beta_coeff = float(ch.get("beta_coeff", 0.005))
            spend = float(ch.get("spend_nation", 50000.0))
            start = int(ch.get("start", 0))
            stop = int(ch.get("stop", max(100000, int(spend * 2.5))))
            step = int(ch.get("step", max(1000, int(stop / 50))))
            price = float(ch.get("price", 1.0))
            sat_fn = ch.get("saturation_function", "log")
            power_val = float(ch.get("power_value", 0.5))

            # Named, so a channel that cannot be calibrated says which one it
            # is rather than failing the whole batch anonymously.
            try:
                df = create_response_curve(
                    channel_name=channel_name,
                    impactable_sales_nation=impactable_sales,
                    beta_coeff=beta_coeff,
                    spend_nation=spend,
                    start=start,
                    stop=stop,
                    step=step,
                    price=price,
                    saturation_function=sat_fn,
                    power_value=power_val,
                    num_time=num_time,
                    num_geo=num_geo,
                )
            except ValueError as exc:
                raise ValueError(f"{channel_name}: {exc}") from exc


            # Clean non-finite floats. This used to replace NaN only, which
            # left inf and -inf in the frame. Starlette's JSONResponse calls
            # json.dumps with allow_nan=False, so those raised while the
            # response was being rendered - after this handler returned, and
            # so past the except below. The client got a bare 500 with no CORS
            # headers, which a browser reports as "the backend did not
            # respond" rather than as a server error.
            clean_records = (
                df.replace([np.inf, -np.inf], np.nan).replace({np.nan: None})
                  .to_dict(orient="records")
            )
            results[channel_name] = clean_records

        return {"curves": results}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Response curve generation failed: {str(e)}")