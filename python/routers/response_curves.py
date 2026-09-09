import json
from fastapi import APIRouter, HTTPException
from core.processing import create_response_curve

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
            df = create_response_curve(
                channel_name=ch["name"],
                impactable_sales_nation=ch["impactable_sales_nation"],
                beta_coeff=ch["beta_coeff"],
                spend_nation=ch["spend_nation"],
                start=ch["start"],
                stop=ch["stop"],
                step=ch["step"],
                price=ch["price"],
                saturation_function=ch["saturation_function"],
                power_value=ch.get("power_value", 0.5),
                num_time=num_time,
                num_geo=num_geo,
            )
            results[ch["name"]] = df.to_dict(orient="records")
        return {"curves": results}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
