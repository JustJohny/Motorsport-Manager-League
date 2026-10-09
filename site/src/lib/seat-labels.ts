import type { Seat } from "../../../src/preseason.ts"

export const SEAT_LABEL: Record<Seat["role"], string> = {
  car1: "Car 1", car2: "Car 2", reserve: "Reserve", engineer: "Lead engineer", mechanic: "Mechanic", other: "Staff",
}
