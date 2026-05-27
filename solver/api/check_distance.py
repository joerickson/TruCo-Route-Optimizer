"""Pure checks for the tiered travel-speed model. Run:
python3 solver/api/check_distance.py   (no OR-Tools needed)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from distance_matrix import drive_minutes, haversine_miles, ROAD_FACTOR

base = (40.0, -111.0)

# --- travel time is monotonic in distance (longer trip => more minutes) ---
pts = [(40.00, -111.0), (40.02, -111.0), (40.05, -111.0), (40.20, -111.0), (40.60, -111.0)]
times = [drive_minutes(base[0], base[1], p[0], p[1]) for p in pts]
assert times == sorted(times), times

# --- a short in-neighborhood hop runs at the slow (~25 mph) tier ---
near = (40.02, -111.0)  # ~1.4 mi straight-line -> ~1.8 road mi (within the <=3 mi tier)
road_n = haversine_miles(*base, *near) * ROAD_FACTOR
eff_near = road_n / (drive_minutes(*base, *near) / 60.0)
assert 24.0 <= eff_near <= 26.0, (eff_near, road_n)

# --- a long haul averages mostly freeway: effective speed well above the old flat 30 mph ---
far = (40.60, -111.0)  # ~41 mi straight-line -> ~54 road mi (mostly the >12 mi / 65 mph tier)
road_f = haversine_miles(*base, *far) * ROAD_FACTOR
mins_f = drive_minutes(*base, *far)
eff_far = road_f / (mins_f / 60.0)
assert eff_far > 50.0, (eff_far, road_f, mins_f)

# --- the long haul is meaningfully faster than the old flat-30 model would give ---
old_flat_mins = road_f / 30.0 * 60.0
assert mins_f < old_flat_mins * 0.75, (mins_f, old_flat_mins)

print("check_distance: PASS")
