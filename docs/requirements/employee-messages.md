# Messages to employees (notification centre)

HR, payroll staff and managers send messages that employees read in the app under **My messages**.
An unread count shows in the menu.

| Sender                                 | Can send                                                   | To whom                                                                    |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| HR (`employees.manage`)                | any type: payroll, performance, leave, attendance, general | everyone, a branch, a department, one employee (within their branch scope) |
| Payroll (`payroll.manage`)             | payroll messages                                           | same as HR                                                                 |
| Reporting manager (has direct reports) | performance, leave, attendance, general                    | their own team, or one team member                                         |

- An individual message (for example a performance note) is visible only to that employee, the sender
  and HR.
- **Automatic:** approving a payroll run sends each included employee "Your payslip for <month> is
  ready". Amounts stay on the payslip, not in the message.
- **Optional SMS alert:** "you have a new message", with a link to the app and never the content.
  It needs a separate DLT-approved MSG91 template (`MSG91_MESSAGE_ALERT_TEMPLATE_ID`, two
  variables: organization name and link). The checkbox appears only when SMS is set up.
- Senders see read counts. HR sees every message sent in the organization. Every send is audited.

## API

| Endpoint                                                    | Purpose                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /messages/options`                                     | What the caller may send and to whom                       |
| `POST /messages`                                            | Send (`category`, `title`, `body`, `audience`, `smsAlert`) |
| `GET /messages/sent`                                        | Sent messages with read counts                             |
| `GET /me/messages`                                          | Inbox with unread count                                    |
| `POST /me/messages/:id/read` · `POST /me/messages/read-all` | Mark as read                                               |
