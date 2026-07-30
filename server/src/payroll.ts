import crypto from 'node:crypto';
import { calculateEmployeePayroll } from './employee-payroll.js';
import { calculateInternPayroll, manilaWeekStart } from './intern-payroll.js';
import type { GoogleSheetsService, SheetAttendance, SheetPayroll, SheetUser } from './sheets.js';

export class PayrollService {
  constructor(private readonly sheets: GoogleSheetsService) {}

  async ensureForCompletedAttendance(attendance: SheetAttendance, user: SheetUser): Promise<SheetPayroll> {
    if (!attendance.timeIn || !attendance.timeOut || attendance.status !== 'COMPLETED') throw new Error('Payroll requires completed attendance');
    const existing = await this.sheets.findPayrollByAttendanceId(attendance.attendanceId);
    if (existing) return existing;

    if ((user.employeeType ?? 'INTERN') === 'EMPLOYEE') {
      const dailyRate = user.dailyRate;
      if (dailyRate === null || dailyRate === undefined) throw new Error('Employee daily rate is required for payroll');
      const calculation = calculateEmployeePayroll({ actualTimeIn: attendance.timeIn, actualTimeOut: attendance.timeOut, dailyRate });
      return this.sheets.createPayroll({
        payrollId: crypto.randomUUID(), attendanceId: attendance.attendanceId, userId: user.userId, fullName: user.fullName, employeeType: 'EMPLOYEE', attendanceDate: attendance.attendanceDate,
        actualTimeIn: attendance.timeIn, actualTimeOut: attendance.timeOut, computedTimeIn: calculation.computedTimeIn, computedTimeOut: calculation.computedTimeOut,
        graceUsed: null, lateHours: calculation.lateHours, lateDeduction: calculation.lateDeduction, basePay: calculation.basePay, dailyPay: calculation.dailyPay, notes: 'Employee late rules pending client approval',
      });
    }

    const weekStart = manilaWeekStart(attendance.attendanceDate);
    const grace = await this.sheets.findInternGrace(user.userId, weekStart);
    const graceAvailable = !grace || grace.attendanceId === attendance.attendanceId;
    const calculation = calculateInternPayroll({ attendanceDate: attendance.attendanceDate, actualTimeIn: attendance.timeIn, actualTimeOut: attendance.timeOut, graceAvailable });
    if (calculation.graceUsed && !grace) {
      await this.sheets.claimInternGrace({ graceId: crypto.randomUUID(), userId: user.userId, weekStart, attendanceId: attendance.attendanceId, usedAt: attendance.timeIn });
    }
    return this.sheets.createPayroll({
      payrollId: crypto.randomUUID(), attendanceId: attendance.attendanceId, userId: user.userId, fullName: user.fullName, employeeType: 'INTERN', attendanceDate: attendance.attendanceDate,
      actualTimeIn: attendance.timeIn, actualTimeOut: attendance.timeOut, computedTimeIn: calculation.computedTimeIn, computedTimeOut: calculation.computedTimeOut,
      graceUsed: calculation.graceUsed, lateHours: calculation.lateHours, lateDeduction: calculation.lateDeduction, basePay: calculation.basePay, dailyPay: calculation.dailyPay,
      notes: calculation.graceUsed ? 'First weekly late grace applied' : calculation.lateHours ? 'Late deduction applied' : '',
    });
  }
}
