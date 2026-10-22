(function () {
  "use strict";

  const input = document.getElementById("code");
  const form = document.getElementById("pair-form");
  const hint = document.getElementById("code-hint");

  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 6);
    input.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const digits = input.value.replace(/\D/g, "");
    if (digits.length !== 6) {
      hint.textContent = "请输入完整的 6 位数字配对码。";
      hint.style.color = "var(--danger)";
      input.focus();
      return;
    }
    location.href = "/p/" + digits;
  });

  input.focus();
})();
