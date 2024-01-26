// interface Period {
//     years: number;
//     months: number;
//     days: number;
//   }
  

const source = `
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;

import java.io.IOException;
import java.time.Period;

public class PeriodSerializer extends StdSerializer<Period> {

    protected PeriodSerializer() {
        super(Period.class);
    }

    @Override
    public void serialize(Period value, JsonGenerator gen, SerializerProvider provider) throws IOException {
        gen.writeStartObject();
        gen.writeNumberField("years", value.getYears());
        gen.writeNumberField("months", value.getMonths());
        gen.writeNumberField("days", value.getDays());
        gen.writeEndObject();
    }
}
`
export default source.trim();