// electron/activation.js
// Page logic for the activation screen. Talks to the main process ONLY through
// window.mizanLicense (exposed by preload-license.js under context isolation).
const statusBox = document.getElementById('status-box');
const machineInput = document.getElementById('machine-id');
const licenseInput = document.getElementById('license-key');
const activateBtn = document.getElementById('activate-btn');
const trialBtn = document.getElementById('trial-btn');
const trialEmail = document.getElementById('trial-email');

const REASONS = {
  no_key: 'No license is installed on this computer yet.',
  invalid_key: 'That does not look like a valid license key.',
  invalid_signature: 'This license key is not valid for this software.',
  expired: 'This license has expired. Contact your software provider for a renewed key.',
  wrong_machine: 'This license key belongs to a different computer.',
  clock_rollback: 'The computer clock was moved backwards. Correct the date and time, then restart the app.',
  unknown: 'This license could not be verified.'
};

function showStatus(message, type) {
  statusBox.className = 'status-box ' + type;
  statusBox.textContent = message;
}

function reasonText(reason) {
  return REASONS[reason] || REASONS.unknown;
}

const TRIAL_REASONS = {
  no_key: 'No license is installed on this computer yet.',
  bad_email: 'Please enter a valid email address.',
  already_tried: 'This computer already has a trial key. Check your inbox, or contact the software provider for a license.',
  too_many: 'Too many requests. Please wait a few minutes and try again.',
  missing_machine: 'Could not read this computer\'s Machine ID. Please restart the app.',
  network: 'Could not reach the trial server. Check your internet connection and try again.',
  unknown: 'Something went wrong requesting your trial. Please try again or contact the software provider.'
};

function trialReasonText(reason) {
  return TRIAL_REASONS[reason] || TRIAL_REASONS.unknown;
}

async function init() {
  try {
    const machineId = await window.mizanLicense.getMachineId();
    machineInput.value = machineId || '(unavailable)';

    const status = await window.mizanLicense.getStatus();
    if (status.status === 'ok') {
      showStatus('This software is already activated.', 'ok');
      activateBtn.classList.add('disabled');
      licenseInput.disabled = true;
    } else if (status.status === 'expired' || status.status === 'wrong_machine' || status.status === 'clock_rollback' || status.status === 'invalid') {
      showStatus(reasonText(status.reason), 'error');
    } else {
      showStatus('Activate this software to start using it.', 'warn');
    }
  } catch (e) {
    showStatus('Could not read the activation state. Please restart the app.', 'error');
  }
}

document.getElementById('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(machineInput.value);
  } catch (e) {
    machineInput.select();
    document.execCommand('copy');
  }
  showStatus('Machine ID copied.', 'ok');
});

document.getElementById('quit-btn').addEventListener('click', async () => {
  await window.mizanLicense.quit();
});

activateBtn.addEventListener('click', async () => {
  const key = licenseInput.value.trim();
  if (!key) return showStatus('Paste your license key first.', 'warn');

  activateBtn.classList.add('disabled');
  activateBtn.textContent = 'Verifying...';
  try {
    const result = await window.mizanLicense.activate(key);
    if (result.ok) {
      showStatus('Activation successful. The app will open now.', 'ok');
      licenseInput.value = '';
      activateBtn.classList.remove('disabled');
      activateBtn.textContent = 'Activate';
      // Give the user a moment to see the confirmation, then let main proceed.
      setTimeout(() => {
        showStatus('Opening the app...', 'ok');
        window.mizanLicense.activateFinished();
      }, 900);
    } else {
      showStatus(reasonText(result.reason), 'error');
      activateBtn.classList.remove('disabled');
      activateBtn.textContent = 'Activate';
    }
  } catch (e) {
    showStatus('Activation failed unexpectedly. Please try again.', 'error');
    activateBtn.classList.remove('disabled');
    activateBtn.textContent = 'Activate';
  }
});

trialBtn.addEventListener('click', async () => {
  const email = trialEmail.value.trim();
  if (!email) return showStatus('Enter your email to get the free trial key.', 'warn');

  trialBtn.classList.add('disabled');
  trialBtn.textContent = 'Requesting trial...';
  try {
    const result = await window.mizanLicense.requestTrial(email);
    if (result.ok) {
      showStatus('Trial requested! Check your email for the key, then paste it below and click Activate.', 'ok');
      trialEmail.value = '';
    } else {
      showStatus(trialReasonText(result.reason), 'error');
    }
  } catch (e) {
    showStatus(trialReasonText('network'), 'error');
  } finally {
    trialBtn.classList.remove('disabled');
    trialBtn.textContent = 'Start free trial';
  }
});

init();
