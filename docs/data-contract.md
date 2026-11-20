# Data contract: `wearable.sensor.v1`

Mỗi bản ghi đại diện cho một mẫu của một cảm biến cổ tay. Các cảm biến có tần số khác nhau nên không gộp thành một hàng giả định cùng thời điểm; Spark sẽ gom chúng theo cửa sổ thời gian ở bước tiếp theo.

```json
{
  "schema_version": "wearable.sensor.v1",
  "subject_id": "S2",
  "timestamp": "2017-05-22T10:48:45.000Z",
  "sensor": "HR",
  "unit": "bpm",
  "sample_index": 0,
  "value": 101.0
}
```

- `subject_id`: mã người tham gia trong WESAD; dùng làm ID thiết bị mô phỏng.
- `timestamp`: thời điểm UTC của mẫu.
- `sensor`: `ACC`, `BVP`, `EDA`, `HR`, `IBI` hoặc `TEMP`.
- `value`: số đơn cho các cảm biến đơn trục; đối tượng `{x,y,z}` cho ACC; IBI giữ cả `interval` và `offset`.
- Bản ghi này là dữ liệu đã thu thập trong thí nghiệm, không phải số đo trực tiếp hiện thời từ đồng hồ.
