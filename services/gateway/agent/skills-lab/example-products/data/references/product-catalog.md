# Voltline product catalogue (fictional demo data)

| SKU | Line | Type | Headline spec |
|---|---|---|---|
| VLB12100LFP-BT-G1 | Standard | Battery | 12.8V 100Ah LiFePO4, Bluetooth, BMS 100A |
| VLB12100LFP-M-G2 | Compact | Battery | 12.8V 100Ah LiFePO4, compact, BMS 100A |
| VLB12150-CIBUS-G1 | Pro | Battery | 12.8V 150Ah LiFePO4, CI-Bus interface, self-heating |
| VLC2430LINK-G1 | LINK | MPPT charge controller | 12/24V, 30A, max PV input 90 VDC |
| VLI1220PCH-G1 | Pro | Inverter-charger | 12V, 2000W pure sine, 80A charger |
| VLHCP-C02W01-G1 | LINK | Smart hub | CAN / Bluetooth / Wi-Fi gateway, app monitoring |

## Selection notes

- Motorhomes with CI-Bus wiring → `VLB12150-CIBUS-G1` (the bus reports state of charge to the panel).
- Campervans with a single 12V circuit → `VLB12100LFP-M-G2` + `VLC2430LINK-G1`.
- Shore-power heavy builds → add `VLI1220PCH-G1`.
