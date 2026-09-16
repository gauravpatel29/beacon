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
            
            # Clean non-finite floats
            clean_records = df.replace({np.nan: None}).to_dict(orient="records")
            results[channel_name] = clean_records

        return {"curves": results}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Response curve generation failed: {str(e)}")