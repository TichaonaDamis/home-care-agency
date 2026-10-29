import { api } from '../api.js';
import { esc, fields, onSubmit, toast } from '../ui.js';

export async function render(el, parts, query, ctx) {
  el.innerHTML = `<div class="page-head"><div><h1>Change password</h1><p>${esc(ctx.me.user.display_name)} (${esc(ctx.me.user.username)})</p></div></div>
    <section class="card"><form class="form" id="pw">${fields([
    { name: 'current_password', label: 'Current password', type: 'password', required: true },
    { name: 'new_password', label: 'New password', type: 'password', required: true, hint: 'At least 10 characters, letters plus numbers or symbols.' },
    { name: 'confirm', label: 'Confirm new password', type: 'password', required: true },
  ])}<div class="actions"><button class="btn primary" type="submit">Update password</button></div></form>
    <p class="hint">Changing your password signs you out on other devices.</p></section>`;
  onSubmit(el.querySelector('#pw'), async (v, form) => {
    if (v.new_password !== v.confirm) throw Object.assign(new Error('Passwords do not match.'), { details: { confirm: 'Does not match' } });
    await api.post('/auth/change-password', { current_password: v.current_password, new_password: v.new_password });
    form.reset();
    toast('Password updated.', 'ok');
  });
}
