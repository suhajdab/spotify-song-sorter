fetch('/auth/status')
  .then(response => response.json())
  .then(data => {
    if (data.loggedIn) window.location.replace('/playlists.html');
  });

const params = new URLSearchParams(location.search);
const error = params.get('error');
if (error) {
  const banner = document.getElementById('errorBanner');
  banner.textContent = 'Login failed: ' + error.replace(/_/g, ' ');
  banner.style.display = 'block';
}
