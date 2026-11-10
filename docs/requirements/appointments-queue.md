# Appointments, queue and clinic dashboard (Phases 5 and 7)

## Workflows

1. **Doctors and hours.** A doctor manager adds doctors. Each doctor has a branch, optionally a login
   account, a typical consultation length, an online booking window and an on/off switch for online
   booking. Each doctor also has weekly sessions (day, from, to, slot length, patients per slot) and
   days off.
2. **Booking.** Bookings come from reception, the patient site or WhatsApp. Each slot holds up to
   "patients per slot" bookings. Reception may overbook a full slot after confirming, and this is
   audited. A patient can hold one active booking per doctor per day. Bookings run in a transaction
   that locks the doctor row. An `Idempotency-Key` header makes retries safe.
3. **Token.** A token is issued at booking time, so the patient can follow the queue from home.
   Walk-ins get the next token when they are added. Tokens come from a per-doctor, per-day counter
   in the same transaction, so two bookings never share a number.
4. **Arrival.** "Arrived" (check-in) is allowed only on the appointment day. Walk-ins are added as
   already arrived.
5. **Queue.** The status flow is booked → waiting → called → with doctor → done, with no-show,
   cancel and "back to queue" at the allowed points. "Call next" picks the next arrived patient by
   priority, then token. Raising priority (normal, priority, urgent) and cancelling need a reason
   and are audited. Doctors may run only their own queue and cannot cancel. Reception and clinic
   managers can act on every queue in their branches. "Close day" marks everyone not seen as a
   no-show.
6. **Patient tracking link** (`/track/<code>`). Every booking has a random, unguessable code. The
   page shows the token, slot, status, the token being served now, how many people are ahead and an
   approximate wait. The wait is the people ahead × the average consultation time; the doctor's
   typical length is used until three consultations have finished that day. The page never shows
   the patient's name or any medical details. The wait is always labelled as an estimate.
7. **Waiting-room display** (`/queue-display/<doctorId>`). A full-screen page for a TV showing token
   numbers only. It needs a signed-in staff browser.
8. **Clinic dashboard** (`/clinic`). Today's numbers per doctor: now serving, waiting, not arrived,
   seen, no-show, walk-ins, average wait and average consultation time.
9. **Visit history.** Each patient's appointments and walk-ins are shown on the patient profile.

Live screens poll every 5 seconds (the dashboard every 15 seconds). That is enough for a pilot; a
WebSocket push can replace polling later without changing the API.

## Permissions

| Permission            | Granted to                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `doctors.manage`      | owner, admin, clinic manager                                          |
| `appointments.read`   | owner, admin, clinic manager, receptionist, doctor, nurse             |
| `appointments.manage` | owner, admin, clinic manager, receptionist                            |
| `queue.manage`        | owner, admin, clinic manager, receptionist, doctor (own queue), nurse |

## API

| Area         | Endpoints                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Doctors      | `GET/POST /doctors` · `GET/PATCH /doctors/:id` · `GET/PUT /doctors/:id/schedule` · `GET/POST /doctors/:id/time-off` · `DELETE /doctors/:id/time-off/:offId` · `GET /doctors/:id/slots?date=`                                                                 |
| Appointments | `GET /appointments?date=&from=&to=&doctorId=&patientId=&status=` · `POST /appointments` (optional `Idempotency-Key`) · `POST /appointments/:id/cancel` · `POST /appointments/:id/reschedule`                                                                 |
| Queue        | `GET /queue?doctorId=&date=` · `GET /queue/summary` · `GET /queue/visits?patientId=` · `POST /queue/walk-ins` · `POST /queue/call-next` · `POST /queue/close-day` · `POST /queue/entries/:id/{check-in,call,start,complete,no-show,cancel,requeue,priority}` |
| Public       | `GET /public/track/:code`                                                                                                                                                                                                                                    |

## Pilot notes

- Times are shown in Indian time (the branch timezone is stored for later multi-timezone use).
- Adding a day off does not cancel existing bookings. The API reports how many patients are
  affected so reception can contact them.
- Tests that book "today" can fail in the last few minutes before midnight IST (there are no future
  slots left).
