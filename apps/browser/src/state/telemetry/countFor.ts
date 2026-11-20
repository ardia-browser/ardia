import { capture } from "./client";
import { recordStaleCountsWith } from "./consentPeriod";

recordStaleCountsWith((event, fields) => capture(event, fields, null));

export { countFor, fieldName, fieldsOf } from "./consentPeriod";
