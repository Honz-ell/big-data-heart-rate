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
- `timestamp`: thời điểm UTC gốc của mẫu trong WESAD; đây là thời gian Edge và PostgreSQL hiển thị.
- `sensor`: `ACC`, `BVP`, `EDA`, `HR`, `IBI` hoặc `TEMP`.
- `value`: số đơn cho các cảm biến đơn trục; đối tượng `{x,y,z}` cho ACC; IBI giữ cả `interval` và `offset`.
- `stream_timestamp` (Producer thêm): thời gian sự kiện nội bộ tăng đơn điệu để Spark watermark chấp nhận các lần replay về offset cũ. Spark trừ độ dịch trước khi lưu, nên `window_start_utc` vẫn theo thời gian gốc.
- `replay_shift_seconds` (Producer thêm): số giây dịch đã cấp từ `replay_stream_clock` trong PostgreSQL.
- Bản ghi này là dữ liệu đã thu thập trong thí nghiệm, không phải số đo trực tiếp hiện thời từ đồng hồ.

Khi kết thúc một replay, Producer gửi thêm một bản tin điều khiển `sensor="__CONTROL__"` để Spark chốt các cửa sổ cuối. Spark loại bản tin này khỏi bảng tổng hợp và Edge bỏ qua vì đây không phải cảm biến.
