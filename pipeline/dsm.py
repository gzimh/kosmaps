"""Top-down surface model (DSM) in local east/north metres, built by inverse-projecting every mosaic pixel."""
import json, math
import numpy as np
g = json.load(open("tiles_raw/grid.json"))
MPP = g["M_PER_PX"]; NPX = (2 * g["R"] + 1) * g["CORE"]; X0 = NPX / 2; S2 = math.sqrt(.5)
H = np.load("height_mosaic.npy")
Ys, Xs = np.mgrid[0:NPX, 0:NPX]
x = (Xs + .5 - X0) * MPP; y = (X0 - (Ys + .5)) * MPP
A = x / S2; B = 2 * (y - S2 * H)
E = (A + B) / 2; N = (B - A) / 2
RES, EXT = 0.5, 700
G = int(2 * EXT / RES)
ok = np.isfinite(H) & (np.abs(E) < EXT) & (np.abs(N) < EXT)
ci = ((E[ok] + EXT) / RES).astype(np.int64); cj = ((EXT - N[ok]) / RES).astype(np.int64)
dsm = np.full(G * G, -np.inf, np.float32)
np.maximum.at(dsm, cj * G + ci, H[ok])
dsm = dsm.reshape(G, G); dsm[~np.isfinite(dsm)] = np.nan
np.save("dsm.npy", dsm)
print("dsm", dsm.shape, "filled", np.isfinite(dsm).mean().round(3))
