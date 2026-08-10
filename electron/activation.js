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
  no_key: 'Aucune licence n\'est installée sur cet ordinateur pour le moment.',
  invalid_key: 'Ceci ne ressemble pas à une clé de licence valide.',
  invalid_signature: 'Cette clé de licence n\'est pas valide pour ce logiciel.',
  expired: 'Cette licence a expiré. Contactez votre fournisseur de logiciel pour une nouvelle clé.',
  wrong_machine: 'Cette clé de licence appartient à un autre ordinateur.',
  clock_rollback: 'L\'horloge de l\'ordinateur a été reculée. Corrigez la date et l\'heure, puis redémarrez l\'application.',
  unknown: 'Cette licence n\'a pas pu être vérifiée.'
};

function showStatus(message, type) {
  statusBox.className = 'status-box ' + type;
  statusBox.textContent = message;
}

function reasonText(reason) {
  return REASONS[reason] || REASONS.unknown;
}

const TRIAL_REASONS = {
  no_key: 'Aucune licence n\'est installée sur cet ordinateur pour le moment.',
  bad_email: 'Veuillez saisir une adresse e-mail valide.',
  already_tried: 'Cet ordinateur a déjà une clé d\'essai. Vérifiez votre boîte de réception, ou contactez le fournisseur du logiciel pour une licence.',
  too_many: 'Trop de demandes. Veuillez patienter quelques minutes et réessayer.',
  missing_machine: 'Impossible de lire l\'identifiant machine de cet ordinateur. Redémarrez l\'application.',
  network: 'Impossible de contacter le serveur d\'essai. Vérifiez votre connexion internet et réessayez.',
  unknown: 'Une erreur est survenue lors de la demande d\'essai. Réessayez ou contactez le fournisseur du logiciel.'
};

function trialReasonText(reason) {
  return TRIAL_REASONS[reason] || TRIAL_REASONS.unknown;
}

async function init() {
  try {
    const machineId = await window.mizanLicense.getMachineId();
    machineInput.value = machineId || '(indisponible)';

    const status = await window.mizanLicense.getStatus();
    if (status.status === 'ok') {
      showStatus('Ce logiciel est déjà activé.', 'ok');
      activateBtn.classList.add('disabled');
      licenseInput.disabled = true;
    } else if (status.status === 'expired' || status.status === 'wrong_machine' || status.status === 'clock_rollback' || status.status === 'invalid') {
      showStatus(reasonText(status.reason), 'error');
    } else {
      showStatus('Activez ce logiciel pour commencer à l\'utiliser.', 'warn');
    }
  } catch (e) {
    showStatus('Impossible de lire l\'état d\'activation. Redémarrez l\'application.', 'error');
  }
}

document.getElementById('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(machineInput.value);
  } catch (e) {
    machineInput.select();
    document.execCommand('copy');
  }
  showStatus('Identifiant machine copié.', 'ok');
});

document.getElementById('quit-btn').addEventListener('click', async () => {
  await window.mizanLicense.quit();
});

activateBtn.addEventListener('click', async () => {
  const key = licenseInput.value.trim();
  if (!key) return showStatus('Collez d\'abord votre clé de licence.', 'warn');

  activateBtn.classList.add('disabled');
  activateBtn.textContent = 'Vérification...';
  try {
    const result = await window.mizanLicense.activate(key);
    if (result.ok) {
      showStatus('Activation réussie. L\'application va s\'ouvrir.', 'ok');
      licenseInput.value = '';
      activateBtn.classList.remove('disabled');
      activateBtn.textContent = 'Activer';
      // Give the user a moment to see the confirmation, then let main proceed.
      setTimeout(() => {
        showStatus('Ouverture de l\'application...', 'ok');
        window.mizanLicense.activateFinished();
      }, 900);
    } else {
      showStatus(reasonText(result.reason), 'error');
      activateBtn.classList.remove('disabled');
      activateBtn.textContent = 'Activer';
    }
  } catch (e) {
    showStatus('Échec inattendu de l\'activation. Réessayez.', 'error');
    activateBtn.classList.remove('disabled');
    activateBtn.textContent = 'Activer';
  }
});

trialBtn.addEventListener('click', async () => {
  const email = trialEmail.value.trim();
  if (!email) return showStatus('Entrez votre e-mail pour obtenir la clé d\'essai gratuit.', 'warn');

  trialBtn.classList.add('disabled');
  trialBtn.textContent = 'Demande d\'essai...';
  try {
    const result = await window.mizanLicense.requestTrial(email);
    if (result.ok) {
      showStatus('Essai demandé ! Vérifiez votre e-mail pour la clé, puis collez-la ci-dessous et cliquez sur Activer.', 'ok');
      trialEmail.value = '';
    } else {
      showStatus(trialReasonText(result.reason), 'error');
    }
  } catch (e) {
    showStatus(trialReasonText('network'), 'error');
  } finally {
    trialBtn.classList.remove('disabled');
    trialBtn.textContent = 'Démarrer l\'essai gratuit';
  }
});

init();
